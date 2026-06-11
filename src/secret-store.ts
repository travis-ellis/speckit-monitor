import { execFileSync } from "child_process";

// Encrypt/decrypt secrets at rest using the Windows Data Protection API
// (DPAPI, CurrentUser scope). The resulting blob is bound to the current
// Windows user account and cannot be decrypted by another user or on another
// machine, even with full read access to the state file. DPAPI is used
// (rather than Electron's safeStorage) so that both the Electron app and the
// plain-Node CLI — which run in different runtimes but as the same user — can
// read the same stored credentials.

const ENCRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($in.Trim())
$prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($prot))
`;

const DECRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($in.Trim())
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

function isEncryptionAvailable(): boolean {
  return process.platform === "win32";
}

function runPowerShell(script: string, inputB64: string): string {
  // -EncodedCommand takes a base64-UTF16LE script, sidestepping all shell
  // quoting. Payload travels as base64 over stdin so console code pages and
  // special characters can never corrupt it.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      input: inputB64,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }
  ).trim();
}

// Returns a base64 DPAPI blob. Throws if encryption is unavailable.
export function encryptSecret(plaintext: string): string {
  if (!isEncryptionAvailable()) {
    throw new Error("Secret encryption is only supported on Windows (DPAPI).");
  }
  const inputB64 = Buffer.from(plaintext, "utf8").toString("base64");
  return runPowerShell(ENCRYPT_SCRIPT, inputB64);
}

// Takes a base64 DPAPI blob, returns the plaintext. Throws if the blob cannot
// be decrypted (e.g. created by a different user or on a different machine).
export function decryptSecret(cipherB64: string): string {
  const outB64 = runPowerShell(DECRYPT_SCRIPT, cipherB64.trim());
  return Buffer.from(outB64, "base64").toString("utf8");
}
