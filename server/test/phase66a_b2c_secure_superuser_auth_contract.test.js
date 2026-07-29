'use strict';

/**
 * Phase 66A-B2C — STATIC CONTRACT for the secure superuser authentication probe.
 *
 * This suite reads server/scripts/db/phase66a_b2c_secure_superuser_auth.ps1 as
 * TEXT and asserts its security properties. It never runs the helper, never
 * invokes PowerShell, never invokes psql, never opens a database connection and
 * never causes a credential dialog to appear.
 *
 * Two views of the file are used deliberately:
 *
 *   SRC   the raw text — for header and prose assertions
 *   CODE  the same file with comments stripped — for every SECURITY assertion,
 *         so a reassuring sentence in a comment can never satisfy a requirement
 *         the executable code does not actually meet.
 *
 * ENVIRONMENT NOTE, recorded here because it shapes one assertion:
 * ProcessStartInfo.ArgumentList does not exist on .NET Framework, which is what
 * Windows PowerShell 5.1 runs on, and PowerShell 7 is not installed. The helper
 * therefore achieves the same guarantee a different way, and the test below
 * pins that construction rather than pretending ArgumentList is present.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SERVER_DIR  = path.join(__dirname, '..');
const HELPER_PATH = path.join(SERVER_DIR, 'scripts', 'db', 'phase66a_b2c_secure_superuser_auth.ps1');

const SRC = fs.readFileSync(HELPER_PATH, 'utf8');

/** Strip PowerShell block comments and whole-line # comments. */
function stripComments(text) {
  return text
    .replace(/<#[\s\S]*?#>/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}
const CODE = stripComments(SRC);

/** The OUTER catch — the last `catch {` before the top-level `finally {`.
 *  A naive lastIndexOf would find the inner `catch { }` around Proc.Dispose. */
function outerCatchBlock() {
  const finAt = CODE.indexOf('finally {');
  return CODE.slice(CODE.lastIndexOf('catch {', finAt), finAt);
}

/** The top-level finally block only — bounded at its closing brace, so the
 *  statements that follow it are not mistaken for part of cleanup. */
function finallyBlock() {
  const start = CODE.indexOf('finally {');
  const end = CODE.indexOf('\n}\n', start);
  return CODE.slice(start, end === -1 ? CODE.length : end);
}

// ---------------------------------------------------------------------------
// File identity and safety preamble
// ---------------------------------------------------------------------------

test('the helper exists at the exact approved path', () => {
  assert.ok(fs.existsSync(HELPER_PATH), 'phase66a_b2c_secure_superuser_auth.ps1 must exist');
  assert.ok(fs.statSync(HELPER_PATH).isFile());
});

test('the helper opens with strict mode and terminating errors', () => {
  assert.match(CODE, /Set-StrictMode -Version Latest/);
  assert.match(CODE, /\$ErrorActionPreference = 'Stop'/);
});

test('the helper uses structured try / catch / finally', () => {
  assert.match(CODE, /\btry\s*\{/);
  assert.match(CODE, /\bcatch\s*\{/);
  assert.match(CODE, /\bfinally\s*\{/);
});

// ---------------------------------------------------------------------------
// Fixed target — nothing here is configurable
// ---------------------------------------------------------------------------

test('the psql path is the exact PostgreSQL 18 executable', () => {
  assert.match(CODE, /\$PSQL_PATH\s*=\s*'C:\\Program Files\\PostgreSQL\\18\\bin\\psql\.exe'/);
  assert.equal((CODE.match(/psql\.exe/g) || []).length, 1, 'exactly one psql path literal');
});

test('the host is the exact IPv4 loopback literal', () => {
  assert.match(CODE, /\$TARGET_HOST\s*=\s*'127\.0\.0\.1'/);
  assert.ok(!/'localhost'/.test(CODE), 'localhost must not be an accepted target');
  assert.ok(!/'::1'/.test(CODE), 'the IPv6 loopback must not be an accepted target');
});

test('the port is exactly 5432', () => {
  assert.match(CODE, /\$TARGET_PORT\s*=\s*'5432'/);
});

test('the database is exactly qyrvia_test', () => {
  assert.match(CODE, /\$TARGET_DB\s*=\s*'qyrvia_test'/);
});

test('the login is exactly postgres', () => {
  assert.match(CODE, /\$TARGET_USER\s*=\s*'postgres'/);
});

test('no script-level parameter block exists, so nothing can be overridden', () => {
  // A script-level param() sits at column 0. The only param() blocks permitted
  // are the indented signatures of the two internal helper functions, which
  // take no credential and no target.
  assert.ok(!/^param\s*\(/im.test(CODE), 'the script must accept no parameters at all');
  const paramBlocks = CODE.match(/param\([^)]*\)/g) || [];
  assert.deepEqual(paramBlocks, [
    'param([string]$Value)',
  ], 'only the argument-quoting helper may declare parameters');
  for (const forbidden of ['$Password', '$PlainPassword', '$Host =', '$Port =',
                           '$Database =', '$User =', '$Sql =', '$Query =']) {
    assert.ok(!CODE.includes(forbidden), 'no override parameter may exist: ' + forbidden);
  }
});

test('no environment variable can redirect the target', () => {
  assert.ok(!/\$env:PGHOST\s*=/.test(CODE));
  assert.ok(!/\$env:PGPORT\s*=/.test(CODE));
  assert.ok(!/\$env:PGDATABASE\s*=/.test(CODE));
  assert.ok(!/\$env:PGUSER\s*=/.test(CODE));
  assert.ok(!/\$env:DATABASE_URL/.test(CODE));
  assert.ok(!/\$env:TEST_DATABASE_URL/.test(CODE));
});

// ---------------------------------------------------------------------------
// Credential capture and lifetime
// ---------------------------------------------------------------------------

test('the password is captured through the Windows credential dialog', () => {
  assert.match(CODE, /Get-Credential -UserName \$TARGET_USER -Message \$message/);
  assert.equal((CODE.match(/Get-Credential/g) || []).length, 1, 'exactly one credential prompt');
});

test('a username other than postgres is refused without an auth attempt', () => {
  assert.match(CODE, /\$script:Credential\.UserName -ne \$TARGET_USER/);
  const guard = CODE.slice(CODE.indexOf('$script:Credential.UserName -ne $TARGET_USER'));
  assert.match(guard.slice(0, 120), /\$TOKEN_CANCELLED/,
    'a wrong username must return the cancelled token, never attempt authentication');
});

test('a cancelled dialog yields only the fixed cancelled token', () => {
  assert.match(CODE, /\$TOKEN_CANCELLED\s*=\s*'SUPERUSER_AUTH_CANCELLED'/);
  assert.match(CODE, /if \(\$null -eq \$script:Credential\) \{ return \$TOKEN_CANCELLED \}/);
  assert.ok(/Get-Credential[\s\S]{0,300}?catch \{[\s\S]{0,300}?return \$TOKEN_CANCELLED/.test(CODE),
    'a throwing credential prompt must map to CANCELLED, not to an internal error');
});

test('the password stays a SecureString until the last possible moment', () => {
  const convertAt = CODE.indexOf('SecureStringToBSTR');
  const startAt   = CODE.indexOf('[System.Diagnostics.Process]::Start');
  assert.ok(convertAt > -1, 'conversion must go through the marshalling API');
  assert.ok(startAt > -1);
  assert.ok(convertAt < startAt, 'conversion happens immediately before the child starts');
  assert.match(CODE, /PtrToStringBSTR/);
});

test('the SecureString and credential are never serialized', () => {
  for (const bad of ['ConvertFrom-SecureString', 'ConvertTo-SecureString',
                     'Export-Clixml', 'Import-Clixml']) {
    assert.ok(!CODE.includes(bad), 'forbidden serialization: ' + bad);
  }
  assert.ok(!/ConvertTo-Json[^\n]*credential/i.test(CODE));
});

test('the password is never printed, echoed or measured for output', () => {
  assert.ok(!/Write-Host/.test(CODE), 'Write-Host must not be used at all');
  assert.ok(!/Write-Output[^\n]*\$plain/.test(CODE));
  assert.ok(!/Write-Output[^\n]*PGPASSWORD/.test(CODE));
  assert.ok(!/\$plain\.Length/.test(CODE), 'the password length must never be computed for output');
  assert.ok(!/Write-Output[^\n]*\$credential/.test(CODE));
});

test('the plaintext buffer is zeroed and released in finally', () => {
  const fin = finallyBlock();
  assert.ok(fin.includes('ZeroFreeBSTR'), 'the BSTR must be zeroed and freed');
  assert.ok(/\$script:Plain\s*=\s*\$null/.test(fin), 'the plaintext variable must be nulled');
  assert.ok(/\$script:Credential\s*=\s*\$null/.test(fin));
});

test('no persistent credential store is ever written', () => {
  for (const bad of ['cmdkey', 'CredentialManager', 'New-StoredCredential',
                     'pgpass.conf', '.pgpass', 'pg_service', 'psqlrc',
                     'HKCU:', 'HKLM:', 'Set-ItemProperty', 'New-ItemProperty']) {
    assert.ok(!CODE.toLowerCase().includes(bad.toLowerCase()),
      'no credential may be persisted via ' + bad);
  }
  // PGPASSFILE appears only in the strip-list, never as an assignment.
  assert.ok(!/PGPASSFILE\s*=/.test(CODE), 'a pgpass file must never be pointed at');
  assert.ok(/'PGPASSFILE'/.test(CODE), 'PGPASSFILE must be stripped from the child');
});

test('the parent shell environment is never modified', () => {
  assert.ok(!/\$env:PGPASSWORD\s*=/.test(CODE),
    'the password must never enter the parent process environment');
  assert.ok(!/\[Environment\]::SetEnvironmentVariable/.test(CODE));
  assert.ok(!/Set-Item\s+Env:/i.test(CODE));
});

// ---------------------------------------------------------------------------
// Child process contract
// ---------------------------------------------------------------------------

test('the child is launched through ProcessStartInfo, not a shell', () => {
  assert.match(CODE, /New-Object System\.Diagnostics\.ProcessStartInfo/);
  assert.match(CODE, /\$script:Psi\.UseShellExecute\s*=\s*\$false/);
  assert.match(CODE, /\$script:Psi\.CreateNoWindow\s*=\s*\$true/);
  assert.match(CODE, /\[System\.Diagnostics\.Process\]::Start\(\$script:Psi\)/);
});

test('stdout and stderr are redirected and stdin is not', () => {
  assert.match(CODE, /\$script:Psi\.RedirectStandardOutput\s*=\s*\$true/);
  assert.match(CODE, /\$script:Psi\.RedirectStandardError\s*=\s*\$true/);
  assert.match(CODE, /\$script:Psi\.RedirectStandardInput\s*=\s*\$false/);
});

test('the working directory is the repository server directory', () => {
  assert.match(CODE, /\$script:Psi\.WorkingDirectory\s*=/);
  assert.match(CODE, /PSScriptRoot/i, 'the path must be derived from the script location');
});

test('no shell, no nested interpreter and no constructed command is executed', () => {
  for (const bad of ['Invoke-Expression', 'iex ', 'Start-Process', 'cmd.exe', '/c ',
                     'Invoke-Command', 'Enter-PSSession', 'New-PSSession',
                     'powershell.exe', 'pwsh']) {
    assert.ok(!CODE.includes(bad), 'forbidden execution mechanism: ' + bad);
  }
  assert.ok(!/^\s*&\s*["'$]/m.test(CODE), 'the call operator must not launch a built string');
});

test('ArgumentList is unavailable here, so an equivalent guarantee is enforced', () => {
  // .NET Framework ProcessStartInfo has Arguments but not ArgumentList, and
  // PowerShell 7 is not installed. These four properties together give the same
  // protection: literal-only tokens, a hard rejection of anything that could be
  // ambiguous once quoted, no shell, and no credential in the argument vector.
  assert.match(CODE, /\$ARGV = @\(/, 'arguments must live in one explicit array');
  assert.match(CODE, /function ConvertTo-SafeArgument/);
  assert.match(CODE, /if \(\$Value -match '"'\) \{ throw 'unsafe-argument' \}/,
    'a double quote in any token must be rejected outright');
  assert.match(CODE, /if \(\$Value -match '\\\\'\) \{ throw 'unsafe-argument' \}/,
    'a backslash in any token must be rejected outright');
  assert.match(CODE, /\$script:Psi\.Arguments\s*=\s*\$commandLine/);
  // and the command line is assembled only from that validated array
  assert.match(CODE, /foreach \(\$a in \$ARGV\) \{ ConvertTo-SafeArgument -Value \$a \}/);
});

test('every psql argument is a literal, and the required flags are present', () => {
  const argv = CODE.slice(CODE.indexOf('$ARGV = @('), CODE.indexOf(')', CODE.indexOf('$ARGV = @(')));
  for (const flag of ["'-X'", "'-v'", "'ON_ERROR_STOP=1'", "'-h'", "'-p'",
                      "'-U'", "'-d'", "'-A'", "'-t'", "'-q'", "'-c'"]) {
    assert.ok(argv.includes(flag), 'missing required psql argument ' + flag);
  }
  assert.ok(!argv.includes('PGPASSWORD'), 'the password must never be an argument');
  assert.ok(!/-W\b/.test(argv), 'no interactive password flag');
  assert.ok(!/postgres(ql)?:\/\//.test(argv), 'no connection URL may be passed');
});

test('the password reaches psql only through the child environment', () => {
  assert.match(CODE, /\$script:Psi\.Environment\['PGPASSWORD'\]\s*=\s*\$script:Plain/);
  // Exactly three references in executable code: the child assignment, and the
  // ContainsKey/Remove pair that clears it in finally. Nothing else.
  assert.equal((CODE.match(/PGPASSWORD/g) || []).length, 3,
    'PGPASSWORD may appear only in the child assignment and its cleanup');
  assert.equal((CODE.match(/\$script:Psi\.Environment\['PGPASSWORD'\]\s*=/g) || []).length, 1,
    'exactly one assignment, on the child ProcessStartInfo only');
});

test('the child PGPASSWORD entry is removed during cleanup', () => {
  const fin = finallyBlock();
  assert.match(fin, /\$script:Psi\.Environment\.ContainsKey\('PGPASSWORD'\)/);
  assert.match(fin, /\$script:Psi\.Environment\.Remove\('PGPASSWORD'\)/);
});

test('every PG override variable is stripped from the child environment', () => {
  for (const v of ['PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGHOST', 'PGPORT',
                   'PGDATABASE', 'PGUSER', 'DATABASE_URL', 'TEST_DATABASE_URL']) {
    assert.ok(CODE.includes("'" + v + "'"), 'must strip ' + v + ' from the child environment');
  }
  assert.match(CODE, /\$script:Psi\.Environment\.Remove\(\$v\)/);
});

test('the process timeout is bounded at twenty seconds', () => {
  assert.match(CODE, /\$TIMEOUT_MS\s*=\s*20000/);
  assert.match(CODE, /WaitForExit\(\$TIMEOUT_MS\)/);
  assert.match(CODE, /\$script:Proc\.Kill\(\)/, 'a timed-out child must be terminated');
});

test('exactly one process is started and there is no retry', () => {
  assert.equal((CODE.match(/\[System\.Diagnostics\.Process\]::Start/g) || []).length, 1);
  assert.ok(!/\bwhile\s*\(/.test(CODE), 'no loop may re-attempt authentication');
  assert.ok(!/\bdo\s*\{/.test(CODE));
  assert.ok(!/retry/i.test(CODE));
});

test('both output streams are drained so the wait cannot deadlock', () => {
  assert.match(CODE, /StandardOutput\.ReadToEndAsync\(\)/);
  assert.match(CODE, /StandardError\.ReadToEndAsync\(\)/);
});

// ---------------------------------------------------------------------------
// The single authorized statement
// ---------------------------------------------------------------------------

test('exactly one SELECT statement is embedded', () => {
  const sql = CODE.slice(CODE.indexOf('$AUTH_SQL'), CODE.indexOf('$ARGV'));
  assert.equal((sql.match(/SELECT/g) || []).length, 2,
    'the outer SELECT and the EXISTS subquery — and nothing more');
  assert.ok(!sql.includes(';'), 'no semicolon, so a second statement is impossible');
});

test('the statement is read-only', () => {
  const sql = CODE.slice(CODE.indexOf('$AUTH_SQL'), CODE.indexOf('$ARGV'));
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'COPY',
                    'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE',
                    'BEGIN', 'COMMIT', 'ROLLBACK', 'SET ROLE', 'SET ']) {
    assert.ok(!sql.includes(kw), 'forbidden SQL keyword in the auth query: ' + kw);
  }
});

test('the statement touches only pg_catalog.pg_roles', () => {
  const sql = CODE.slice(CODE.indexOf('$AUTH_SQL'), CODE.indexOf('$ARGV'));
  const refs = (sql.match(/\bFROM\s+([A-Za-z_][A-Za-z0-9_.]*)/g) || [])
    .map((s) => s.replace(/^FROM\s+/, ''));
  assert.deepEqual(refs, ['pg_catalog.pg_roles']);
  assert.ok(!/\bJOIN\b/.test(sql), 'no join is needed or permitted');
});

test('the statement has no interpolation and no parameters', () => {
  const sql = CODE.slice(CODE.indexOf('$AUTH_SQL'), CODE.indexOf('$ARGV'));
  assert.ok(!/\$\(/.test(sql), 'no subexpression interpolation');
  assert.ok(!/\$1|\$2/.test(sql), 'no bind parameters');
  // The only PowerShell variable on that line is the assignment target itself.
  assert.equal((sql.match(/\$[A-Za-z_]/g) || []).length, 1);
});

test('the statement returns a fixed token, never role metadata', () => {
  const sql = CODE.slice(CODE.indexOf('$AUTH_SQL'), CODE.indexOf('$ARGV'));
  assert.ok(sql.includes("THEN 'SUPERUSER_AUTH_VALID'"));
  assert.ok(sql.includes("ELSE 'SUPERUSER_AUTH_INVALID'"));
  assert.ok(!/SELECT\s+rolname|SELECT\s+\*/.test(sql), 'no role row may be returned');
});

test('no bootstrap or migration is referenced anywhere', () => {
  assert.ok(!/bootstrap/i.test(SRC));
  assert.ok(!/worker_resolvers/i.test(SRC));
  assert.ok(!/0085/.test(SRC));
  assert.ok(!/\.sql\b/i.test(SRC));
});

// ---------------------------------------------------------------------------
// Result vocabulary and output discipline
// ---------------------------------------------------------------------------

test('the success token is exactly SUPERUSER_AUTH_VALID', () => {
  assert.match(CODE, /\$TOKEN_VALID\s*=\s*'SUPERUSER_AUTH_VALID'/);
});

test('the failure vocabulary is fixed and complete', () => {
  for (const t of ['SUPERUSER_AUTH_INVALID', 'SUPERUSER_AUTH_CANCELLED',
                   'SUPERUSER_AUTH_PSQL_NOT_FOUND', 'SUPERUSER_AUTH_PROCESS_START_FAILED',
                   'SUPERUSER_AUTH_TIMEOUT', 'SUPERUSER_AUTH_REJECTED',
                   'SUPERUSER_AUTH_OUTPUT_INVALID', 'SUPERUSER_AUTH_CLEANUP_FAILED',
                   'SUPERUSER_AUTH_INTERNAL_ERROR']) {
    assert.ok(CODE.includes("'" + t + "'"), 'missing fixed token ' + t);
  }
  const tokens = new Set(CODE.match(/'SUPERUSER_AUTH_[A-Z_]+'/g) || []);
  assert.equal(tokens.size, 10, 'exactly ten result tokens may exist');
});

test('raw stdout is never emitted', () => {
  assert.ok(!/Write-Output\s+\$stdout/.test(CODE));
  assert.ok(!/Write-Output\s+\$trimmed/.test(CODE));
  assert.match(CODE, /\$trimmed -eq \$TOKEN_VALID/,
    'stdout must be compared to a fixed token, not echoed');
});

test('raw stderr is never emitted or inspected', () => {
  assert.ok(!/Write-Output[^\n]*\$stderr/.test(CODE));
  assert.ok(!/\$stderrTask\.Result\s*-match/.test(CODE));
  assert.match(CODE, /\[void\]\$stderrTask\.Result/,
    'stderr must be drained and discarded, never read for meaning');
});

test('no exception detail, message, stack or SQLSTATE can escape', () => {
  assert.ok(!/\$_\.Exception/.test(CODE));
  assert.ok(!/\$_\.ScriptStackTrace/.test(CODE));
  assert.ok(!/Write-Output[^\n]*\$_/.test(CODE));
  assert.ok(!/Write-Error/.test(CODE));
  assert.ok(!/SQLSTATE/i.test(CODE));
  const cat = outerCatchBlock();
  assert.ok(!/\$_/.test(cat), 'the outer catch must never touch the error record');
});

test('exactly one stdout write exists in the whole helper', () => {
  const writes = CODE.match(/Write-Output\s+[^\n]*/g) || [];
  assert.equal(writes.length, 1, 'the helper must emit one token, once');
  assert.match(writes[0], /Write-Output \$result/,
    'the single write must emit the validated result variable');
});

test('exit code 0 is reserved for successful superuser authentication', () => {
  assert.match(CODE, /if \(\$result -eq \$TOKEN_VALID\) \{ exit 0 \}/);
  assert.equal((CODE.match(/exit 0/g) || []).length, 1,
    'exactly one exit-zero path may exist');
  assert.match(CODE, /\nexit 1\s*$/, 'every other outcome must exit non-zero');
});

// ---------------------------------------------------------------------------
// The helper touches nothing it should not
// ---------------------------------------------------------------------------

test('the helper writes no file and creates no artifact', () => {
  for (const bad of ['Set-Content', 'Add-Content', 'Out-File', 'New-Item',
                     'Export-Csv', 'Start-Transcript', 'Tee-Object', '>>', ' > ']) {
    assert.ok(!CODE.includes(bad), 'forbidden file operation: ' + bad);
  }
});

test('the helper never reads server/.env or project_bridge', () => {
  assert.ok(!/\.env\b/.test(SRC), 'no .env file may be referenced');
  assert.ok(!/project_bridge/i.test(SRC));
  assert.ok(!/Get-Content/.test(CODE), 'the helper reads no file at all');
});

test('the helper modifies no service, role or PostgreSQL configuration', () => {
  for (const bad of ['Restart-Service', 'Stop-Service', 'Start-Service',
                     'Set-Service', 'pg_hba', 'pg_ctl', 'ALTER ROLE',
                     'CREATE ROLE', 'scram', 'trust']) {
    assert.ok(!CODE.toLowerCase().includes(bad.toLowerCase()),
      'the helper must not touch ' + bad);
  }
});

test('no production, staging or remote target appears', () => {
  assert.ok(!/prod|staging/i.test(CODE));
  assert.ok(!/\.com|\.net\b|\.io\b|amazonaws|azure|rds\./i.test(CODE));
  const ipv4 = new Set(CODE.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || []);
  assert.deepEqual([...ipv4], ['127.0.0.1'], 'the loopback address is the only IP permitted');
});

test('the helper contains no secret of any kind', () => {
  assert.ok(!/postgres(ql)?:\/\/[^\s'"]*:[^\s'"@]+@/i.test(SRC), 'no credential-bearing URL');
  assert.ok(!/(password|passwd|pwd)\s*=\s*['"][^'"]+['"]/i.test(CODE), 'no password literal');
  assert.ok(!/BEGIN (RSA|OPENSSH|PRIVATE) KEY/.test(SRC));
  assert.ok(!/eyJ[A-Za-z0-9_-]{10}/.test(SRC), 'no embedded token');
});

// ---------------------------------------------------------------------------
// Result-classification integrity (Phase 66A-B2C-E2)
//
// The first operator run returned SUPERUSER_AUTH_CLEANUP_FAILED. The cause was
// not a cleanup problem at all: a single catch-all over the whole body emitted
// the CLEANUP token for ANY failure, so a credential, process or stream error
// was reported as a cleanup failure and the real outcome was destroyed. The
// finally could also append a second token after a primary one.
//
// These tests pin the repair so neither defect can return.
// ---------------------------------------------------------------------------

test('the outer catch never reports an unexpected failure as a cleanup failure', () => {
  const cat = outerCatchBlock();
  assert.ok(!cat.includes('$TOKEN_CLEANUP_FAILED'),
    'this was the root cause: a generic failure must not claim cleanup failed');
  assert.match(cat, /\$result\s*=\s*\$TOKEN_INTERNAL_ERROR/,
    'an unexpected failure must be reported as an internal error');
});

test('the internal-error token exists and is distinct from every other outcome', () => {
  assert.match(CODE, /\$TOKEN_INTERNAL_ERROR\s*=\s*'SUPERUSER_AUTH_INTERNAL_ERROR'/);
  assert.notEqual('SUPERUSER_AUTH_INTERNAL_ERROR', 'SUPERUSER_AUTH_CLEANUP_FAILED');
});

test('the cleanup token is reserved for a genuine failure to destroy the secret', () => {
  const fin = finallyBlock();
  assert.ok(!fin.includes('Write-Output'),
    'the finally must not emit a token of its own — that produced two tokens');
  // Only the two secret-destroying steps may raise the flag.
  const flags = CODE.match(/\$secretCleanupFailed\s*=\s*\$true/g) || [];
  assert.equal(flags.length, 2,
    'exactly the PGPASSWORD removal and the BSTR free may flag a secret failure');
  assert.match(CODE, /if \(\$secretCleanupFailed\) \{ \$result = \$TOKEN_CLEANUP_FAILED \}/,
    'and only that may override the authentication outcome');
});

test('process disposal cannot mask the authentication result', () => {
  const fin = finallyBlock();
  assert.match(fin, /try \{ \$script:Proc\.Dispose\(\) \} catch \{ \}/,
    'disposal is housekeeping, so its failure is swallowed');
});

test('the work returns a token instead of exiting mid-flight', () => {
  assert.match(CODE, /function Invoke-AuthProbe/);
  const fn = CODE.slice(CODE.indexOf('function Invoke-AuthProbe'),
                        CODE.indexOf('$result              = $null'));
  assert.ok(!/\bexit\b/.test(fn),
    'the work function must never exit — the caller decides what is emitted');
  const returns = fn.match(/return \$TOKEN_[A-Z_]+/g) || [];
  assert.ok(returns.length >= 8, 'every outcome must be returned as a token');
});

test('both exit statements sit outside the try and finally', () => {
  const finIdx = CODE.indexOf('finally {');
  const finEnd = CODE.indexOf('\n}', finIdx);
  for (const m of [...CODE.matchAll(/^exit \d|\{ exit \d/gm)]) {
    assert.ok(m.index > finEnd,
      'an exit inside try/finally is what let the token and the exit code disagree');
  }
});

test('the emitted result is validated against the token allowlist first', () => {
  assert.match(CODE, /\$ALL_TOKENS = @\(/);
  assert.match(CODE, /\$ALL_TOKENS -notcontains \$result/,
    'an unrecognised or contaminated result must become an internal error');
  assert.match(CODE, /if \(\$null -eq \$result -or \$ALL_TOKENS -notcontains \$result\)/);
});

test('each cleanup step is independently guarded so one failure cannot skip the rest', () => {
  const fin = finallyBlock();
  assert.ok((fin.match(/try \{/g) || []).length >= 3,
    'PGPASSWORD removal, BSTR free and disposal each need their own guard');
  assert.match(fin, /if \(\$null -ne \$script:Psi\)/, 'null-guarded');
  assert.match(fin, /if \(\$script:Bstr -ne \[IntPtr\]::Zero\)/, 'null-guarded');
  assert.match(fin, /if \(\$null -ne \$script:Proc\)/, 'null-guarded');
});

test('the BSTR free is idempotent and cannot double-free', () => {
  const fin = finallyBlock();
  const freeIdx  = fin.indexOf('ZeroFreeBSTR');
  const resetIdx = fin.indexOf('$script:Bstr = [IntPtr]::Zero');
  assert.ok(freeIdx > -1 && resetIdx > freeIdx,
    'the handle must be reset to zero immediately after being freed');
});

test('every stage maps to the token that actually describes it', () => {
  const fn = CODE.slice(CODE.indexOf('function Invoke-AuthProbe'));
  const stage = (anchor, token) => {
    const at = fn.indexOf(anchor);
    assert.ok(at > -1, 'missing stage anchor: ' + anchor);
    assert.ok(fn.slice(at, at + 400).includes(token),
      anchor + ' must classify as ' + token);
  };
  stage('Test-Path -LiteralPath $PSQL_PATH', '$TOKEN_PSQL_NOT_FOUND');
  stage('ConvertTo-SafeArgument -Value $a',  '$TOKEN_START_FAILED');
  stage('Get-Credential',                    '$TOKEN_CANCELLED');
  stage('[System.Diagnostics.Process]::Start', '$TOKEN_START_FAILED');
  stage('WaitForExit($TIMEOUT_MS)',          '$TOKEN_TIMEOUT');
  stage('if ($exitCode -ne 0)',              '$TOKEN_REJECTED');
  stage('$trimmed -eq $TOKEN_INVALID',       '$TOKEN_OUTPUT_INVALID');
});

test('a faulted output stream cannot be misclassified as a cleanup failure', () => {
  assert.match(CODE, /try \{ \$stdout = \$stdoutTask\.Result \} catch \{ \$stdout = '' \}/,
    'a faulted stdout task must degrade to empty output, then OUTPUT_INVALID');
  assert.match(CODE, /try \{ \[void\]\$stderrTask\.Result \} catch \{ \}/,
    'stderr is drained best-effort and never inspected');
});

// ---------------------------------------------------------------------------
// This suite is preparation-only
// ---------------------------------------------------------------------------

test('this contract test never executes the helper or reaches a database', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  const loaded = [...new Set([...self.matchAll(/^const\s+[^=\n]+=\s*require\('([^']+)'\)/gm)]
    .map((m) => m[1]))].sort();
  assert.deepEqual(loaded, ['node:assert/strict', 'node:fs', 'node:path', 'node:test'],
    'only Node built-ins may be loaded — never a driver, a shell or the helper');
  assert.ok(!/\brequire\(\s*HELPER_PATH\s*\)/.test(self));
  assert.ok(!/\bexecFileSync|\bspawnSync\(/.test(self), 'the helper must never be run');
});

test('the helper is not invoked by any application code, script or test', () => {
  const NEEDLE = 'phase66a_b2c_secure_superuser_auth';
  const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);
  const hits = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(js|cjs|mjs|json|sql|ps1|ya?ml)$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (full === HELPER_PATH || full === __filename) continue;
      if (fs.readFileSync(full, 'utf8').includes(NEEDLE)) hits.push(full);
    }
  };

  for (const sub of ['src', 'scripts', 'test']) {
    const dir = path.join(SERVER_DIR, sub);
    if (fs.existsSync(dir)) walk(dir);
  }
  const pkg = path.join(SERVER_DIR, 'package.json');
  if (fs.existsSync(pkg) && fs.readFileSync(pkg, 'utf8').includes(NEEDLE)) hits.push(pkg);

  assert.deepEqual(hits, [], 'the helper must have no automated invocation path');
});
