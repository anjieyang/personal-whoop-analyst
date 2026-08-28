#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const SERVICE = "personal-whoop-analyst";
const API_ROOT = "https://api.prod.whoop.com";
const REDIRECT_URI = "https://anjieyang.com/personal-whoop-analyst/oauth/callback/";
const SCOPES = [
  "offline",
  "read:recovery",
  "read:cycles",
  "read:sleep",
  "read:workout",
  "read:body_measurement",
];
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(PROJECT_ROOT, "data");

function keychainGet(account) {
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", SERVICE, "-a", account],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

function keychainSet(account, value) {
  execFileSync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value],
    { stdio: "ignore" },
  );
}

function keychainDelete(account) {
  try {
    execFileSync(
      "/usr/bin/security",
      ["delete-generic-password", "-s", SERVICE, "-a", account],
      { stdio: "ignore" },
    );
  } catch {
    // The item may already be absent.
  }
}

function requireKeychain(account) {
  const value = keychainGet(account);
  if (!value) throw new Error(`Missing macOS Keychain item: ${account}`);
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function tokenRequest(params) {
  const response = await fetch(`${API_ROOT}/oauth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`WHOOP token request failed (${response.status})`);
  }
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error("WHOOP token response was missing required tokens");
  }
  return payload;
}

function authorize() {
  const clientId = requireKeychain("client_id");
  const state = randomBytes(4).toString("hex");
  keychainSet("oauth_state", state);
  const url = new URL(`${API_ROOT}/oauth/oauth2/auth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  process.stdout.write(`${url.toString()}\n`);
}

async function callback() {
  const callbackUrl = new URL(await readStdin());
  const error = callbackUrl.searchParams.get("error");
  if (error) throw new Error(`WHOOP authorization returned: ${error}`);

  const code = callbackUrl.searchParams.get("code");
  const state = callbackUrl.searchParams.get("state");
  const expectedState = requireKeychain("oauth_state");
  if (!code) throw new Error("WHOOP callback did not contain an authorization code");
  if (!state || state !== expectedState) throw new Error("WHOOP OAuth state validation failed");

  const token = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: requireKeychain("client_id"),
    client_secret: requireKeychain("client_secret"),
    redirect_uri: REDIRECT_URI,
  });
  keychainSet("refresh_token", token.refresh_token);
  keychainDelete("oauth_state");
  process.stdout.write("WHOOP authorization stored in macOS Keychain.\n");
}

async function refreshAccessToken() {
  const token = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: requireKeychain("refresh_token"),
    client_id: requireKeychain("client_id"),
    client_secret: requireKeychain("client_secret"),
    scope: "offline",
  });
  // WHOOP rotates refresh tokens. Persist the replacement before using the access token.
  keychainSet("refresh_token", token.refresh_token);
  return token.access_token;
}

async function apiGet(path, accessToken, query = {}) {
  const url = new URL(`${API_ROOT}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`WHOOP API request failed (${response.status}) for ${path}`);
  }
  return response.json();
}

async function fetchCollection(path, accessToken, start, end) {
  const records = [];
  let nextToken;
  do {
    const page = await apiGet(path, accessToken, {
      start,
      end,
      limit: 25,
      nextToken,
    });
    records.push(...(page.records ?? []));
    nextToken = page.next_token;
  } while (nextToken);
  return records;
}

function newestScored(records) {
  return records.find((record) => record.score_state === "SCORED") ?? records[0] ?? null;
}

function buildLatest(raw) {
  const sleepById = new Map(raw.sleeps.map((sleep) => [sleep.id, sleep]));
  const latestRecovery = raw.recoveries.find((recovery) => recovery.score_state === "SCORED")
    ?? raw.recoveries[0]
    ?? null;
  const recoverySleep = latestRecovery ? sleepById.get(latestRecovery.sleep_id) ?? null : null;

  return {
    synced_at: raw.synced_at,
    range: raw.range,
    recovery: latestRecovery,
    recovery_sleep: recoverySleep,
    latest_sleep: newestScored(raw.sleeps),
    latest_cycle: newestScored(raw.cycles),
    recent_workouts: raw.workouts.slice(0, 10),
    body_measurement: raw.body_measurement,
    record_counts: {
      recoveries: raw.recoveries.length,
      cycles: raw.cycles.length,
      sleeps: raw.sleeps.length,
      workouts: raw.workouts.length,
    },
  };
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function sync() {
  const daysArg = Number(process.argv[3] ?? "35");
  if (!Number.isInteger(daysArg) || daysArg < 1 || daysArg > 3650) {
    throw new Error("Sync days must be an integer between 1 and 3650");
  }

  const accessToken = await refreshAccessToken();
  const end = new Date();
  const start = new Date(end.getTime() - daysArg * 86_400_000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const [recoveries, cycles, sleeps, workouts, bodyMeasurement] = await Promise.all([
    fetchCollection("/developer/v2/recovery", accessToken, startIso, endIso),
    fetchCollection("/developer/v2/cycle", accessToken, startIso, endIso),
    fetchCollection("/developer/v2/activity/sleep", accessToken, startIso, endIso),
    fetchCollection("/developer/v2/activity/workout", accessToken, startIso, endIso),
    apiGet("/developer/v2/user/measurement/body", accessToken),
  ]);

  const raw = {
    synced_at: new Date().toISOString(),
    range: { start: startIso, end: endIso, days: daysArg },
    recoveries,
    cycles,
    sleeps,
    workouts,
    body_measurement: bodyMeasurement,
  };
  const archiveName = raw.synced_at.replaceAll(":", "-");
  const archivePath = resolve(DATA_DIR, "raw", `${archiveName}.json`);
  const latestPath = resolve(DATA_DIR, "latest.json");
  await writePrivateJson(archivePath, raw);
  await writePrivateJson(latestPath, buildLatest(raw));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    latest: latestPath,
    archive: archivePath,
    counts: {
      recoveries: recoveries.length,
      cycles: cycles.length,
      sleeps: sleeps.length,
      workouts: workouts.length,
    },
  })}\n`);
}

async function exportAll() {
  const destinationArg = process.argv[3];
  if (!destinationArg) {
    throw new Error("Usage: whoop.mjs export-all <destination-directory>");
  }

  const destination = resolve(PROJECT_ROOT, destinationArg);
  if (!destination.startsWith(`${PROJECT_ROOT}/`)) {
    throw new Error("Export destination must be inside the project directory");
  }

  const accessToken = await refreshAccessToken();
  const exportedAt = new Date().toISOString();
  const [recoveries, cycles, sleeps, workouts, bodyMeasurement] = await Promise.all([
    fetchCollection("/developer/v2/recovery", accessToken),
    fetchCollection("/developer/v2/cycle", accessToken),
    fetchCollection("/developer/v2/activity/sleep", accessToken),
    fetchCollection("/developer/v2/activity/workout", accessToken),
    apiGet("/developer/v2/user/measurement/body", accessToken),
  ]);

  const manifest = {
    exported_at: exportedAt,
    source: "WHOOP Developer API v2",
    export_scope: "All records returned by the authorized public API endpoints",
    authorized_scopes: SCOPES.filter((scope) => scope !== "offline"),
    excluded: [
      "OAuth credentials and tokens",
      "WHOOP product data not exposed by the public Developer API",
    ],
    files: {
      "recovery.json": recoveries.length,
      "cycles.json": cycles.length,
      "sleep.json": sleeps.length,
      "workouts.json": workouts.length,
      "body_measurement.json": 1,
    },
  };

  await Promise.all([
    writePrivateJson(resolve(destination, "manifest.json"), manifest),
    writePrivateJson(resolve(destination, "recovery.json"), recoveries),
    writePrivateJson(resolve(destination, "cycles.json"), cycles),
    writePrivateJson(resolve(destination, "sleep.json"), sleeps),
    writePrivateJson(resolve(destination, "workouts.json"), workouts),
    writePrivateJson(resolve(destination, "body_measurement.json"), bodyMeasurement),
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    destination,
    counts: {
      recoveries: recoveries.length,
      cycles: cycles.length,
      sleeps: sleeps.length,
      workouts: workouts.length,
      body_measurements: 1,
    },
  })}\n`);
}

async function status() {
  const latestPath = resolve(DATA_DIR, "latest.json");
  let latest = null;
  try {
    latest = JSON.parse(await readFile(latestPath, "utf8"));
  } catch {
    // No successful sync yet.
  }
  process.stdout.write(`${JSON.stringify({
    client_configured: Boolean(keychainGet("client_id") && keychainGet("client_secret")),
    authorized: Boolean(keychainGet("refresh_token")),
    latest_sync: latest?.synced_at ?? null,
    latest_path: latest ? latestPath : null,
    record_counts: latest?.record_counts ?? null,
  }, null, 2)}\n`);
}

const command = process.argv[2];
try {
  if (command === "authorize") authorize();
  else if (command === "callback") await callback();
  else if (command === "export-all") await exportAll();
  else if (command === "sync") await sync();
  else if (command === "status") await status();
  else throw new Error("Usage: whoop.mjs <authorize|callback|export-all|sync|status> [argument]");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
