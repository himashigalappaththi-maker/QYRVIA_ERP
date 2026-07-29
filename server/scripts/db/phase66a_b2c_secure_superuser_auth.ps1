#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
===============================================================================
 Phase 66A-B2C — SECURE OPERATOR-SUPPLIED SUPERUSER AUTHENTICATION PROBE
===============================================================================

 WHAT THIS IS

   An operator-run check that answers one yes/no question:

       does the password you type authenticate as a PostgreSQL SUPERUSER
       against the local test database?

   It prints one fixed token and nothing else. It reads no other information
   from the database, writes nothing anywhere, and changes nothing.

 HOW TO RUN IT (a human does this; nothing automated calls it)

     powershell -NoProfile -ExecutionPolicy Bypass -File `
       server\scripts\db\phase66a_b2c_secure_superuser_auth.ps1

   A Windows credential dialog appears with the username fixed to postgres.
   Type the password there. It is never typed into a terminal, a file, a chat
   window or a command line.

 WHY THE PASSWORD IS SAFE HERE

   * It is captured as a SecureString by the Windows credential dialog.
   * It stays a SecureString until the instant before the child process starts.
   * It is handed to psql ONLY through the child process environment
     (PGPASSWORD), never as an argument, never in a URL, never in a file.
   * The parent shell environment is never touched.
   * The plaintext buffer is zeroed and freed in finally, on every path.
   * Its value and its LENGTH are never printed, logged or measured for output.

 FIXED TARGET — none of this is configurable, by design

     psql      C:\Program Files\PostgreSQL\18\bin\psql.exe
     host      127.0.0.1
     port      5432
     database  qyrvia_test
     login     postgres

   There are no parameters. There is nothing to override — not the password,
   not the host, port, database, role or SQL. A caller cannot point this at
   anything else.

 NOTE ON ARGUMENT PASSING

   ProcessStartInfo.ArgumentList does not exist on .NET Framework, which is
   what Windows PowerShell 5.1 runs on, and PowerShell 7 is not installed on
   this machine. The equivalent safety is achieved instead by:

     * a hard-coded array of literal argument tokens — no variable, no input,
       no credential ever enters it;
     * a runtime assertion that rejects any token containing a double quote or
       a backslash, so the quoting below is provably unambiguous under
       CommandLineToArgvW;
     * UseShellExecute = $false, so no shell ever parses the command line;
     * the password never being an argument in the first place.

 RESULT AND EXIT DISCIPLINE  (revised in Phase 66A-B2C-E2)

   The first operator run returned SUPERUSER_AUTH_CLEANUP_FAILED, which was
   wrong: the previous structure used one catch-all over the whole body that
   emitted the CLEANUP token for ANY failure, so a credential, process or
   stream error was reported as a cleanup problem and the real outcome was
   lost. The finally could also append a second token after a primary one.

   This version fixes both:

     * the work returns a token instead of exiting mid-flight, so exactly one
       token is written, once, at the very end;
     * each stage maps to its own correct token; an unexpected failure is
       SUPERUSER_AUTH_INTERNAL_ERROR, never CLEANUP_FAILED;
     * CLEANUP_FAILED is reserved for a genuine failure to destroy the secret,
       and only that can override an otherwise-successful result;
     * cleanup is idempotent and individually guarded, so one failing step
       cannot skip the others;
     * the single exit is outside try/finally, so the token and the exit code
       can never disagree.

 EXIT CODES

   0  SUPERUSER_AUTH_VALID
   1  every other outcome
===============================================================================
#>

# --- fixed, safe result vocabulary. Nothing else is ever printed. ------------
$TOKEN_VALID          = 'SUPERUSER_AUTH_VALID'
$TOKEN_INVALID        = 'SUPERUSER_AUTH_INVALID'
$TOKEN_CANCELLED      = 'SUPERUSER_AUTH_CANCELLED'
$TOKEN_PSQL_NOT_FOUND = 'SUPERUSER_AUTH_PSQL_NOT_FOUND'
$TOKEN_START_FAILED   = 'SUPERUSER_AUTH_PROCESS_START_FAILED'
$TOKEN_TIMEOUT        = 'SUPERUSER_AUTH_TIMEOUT'
$TOKEN_REJECTED       = 'SUPERUSER_AUTH_REJECTED'
$TOKEN_OUTPUT_INVALID = 'SUPERUSER_AUTH_OUTPUT_INVALID'
$TOKEN_CLEANUP_FAILED = 'SUPERUSER_AUTH_CLEANUP_FAILED'
$TOKEN_INTERNAL_ERROR = 'SUPERUSER_AUTH_INTERNAL_ERROR'

# The complete permitted output set. Anything not on this list is refused.
$ALL_TOKENS = @(
    $TOKEN_VALID, $TOKEN_INVALID, $TOKEN_CANCELLED, $TOKEN_PSQL_NOT_FOUND,
    $TOKEN_START_FAILED, $TOKEN_TIMEOUT, $TOKEN_REJECTED, $TOKEN_OUTPUT_INVALID,
    $TOKEN_CLEANUP_FAILED, $TOKEN_INTERNAL_ERROR
)

# --- the one and only permitted target --------------------------------------
$PSQL_PATH   = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$TARGET_HOST = '127.0.0.1'
$TARGET_PORT = '5432'
$TARGET_DB   = 'qyrvia_test'
$TARGET_USER = 'postgres'
$TIMEOUT_MS  = 20000

# --- the one and only statement ---------------------------------------------
# Single SELECT. No interpolation, no parameters, no semicolon (so a second
# statement is impossible by construction), no DDL, no DML, no transaction
# control, no SET, no GRANT/REVOKE. pg_catalog.pg_roles is the only relation
# touched, and the comparison happens server-side so no role metadata is
# returned — only one of two fixed tokens.
$AUTH_SQL = "SELECT CASE WHEN pg_catalog.current_database() = 'qyrvia_test' AND CURRENT_USER = 'postgres' AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER AND rolsuper = true AND rolcanlogin = true) THEN 'SUPERUSER_AUTH_VALID' ELSE 'SUPERUSER_AUTH_INVALID' END"

# --- the complete argument vector, every element a literal ------------------
$ARGV = @(
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-h', $TARGET_HOST,
    '-p', $TARGET_PORT,
    '-U', $TARGET_USER,
    '-d', $TARGET_DB,
    '-A', '-t', '-q',
    '-c', $AUTH_SQL
)

# --- handles the cleanup block must reach, whatever happened ----------------
$script:Psi        = $null
$script:Bstr       = [IntPtr]::Zero
$script:Proc       = $null
$script:Credential = $null
$script:Plain      = $null

# Quote one already-validated token. Because no token may contain a double
# quote or a backslash (asserted below), wrapping in double quotes is
# unambiguous under CommandLineToArgvW and no escaping is possible or needed.
function ConvertTo-SafeArgument {
    param([string]$Value)
    if ($Value -match '"') { throw 'unsafe-argument' }
    if ($Value -match '\\') { throw 'unsafe-argument' }
    if ($Value -match '\s') { return '"' + $Value + '"' }
    return $Value
}

<#
 Does the work and RETURNS one token. It never writes to the host and never
 calls exit, so the caller stays in control of what is emitted and when. Each
 stage catches its own failure and maps it to the token that actually describes
 it — that is the correction this phase exists to make.
#>
function Invoke-AuthProbe {

    # ---- 1. the executable must be exactly the expected one -----------------
    if (-not (Test-Path -LiteralPath $PSQL_PATH -PathType Leaf)) {
        return $TOKEN_PSQL_NOT_FOUND
    }

    # ---- 2. build the command line from literals only -----------------------
    # This runs BEFORE the credential dialog, so a malformed argument can never
    # reach a point where a password exists in memory.
    $commandLine = $null
    try {
        $quoted = foreach ($a in $ARGV) { ConvertTo-SafeArgument -Value $a }
        $commandLine = [string]::Join(' ', $quoted)
    } catch {
        return $TOKEN_START_FAILED
    }

    # ---- 3. capture the credential ------------------------------------------
    $message = 'Local PostgreSQL 18 TEST database only (127.0.0.1:5432/qyrvia_test). ' +
               'Enter the postgres superuser password. It is never displayed, logged or stored.'
    try {
        $script:Credential = Get-Credential -UserName $TARGET_USER -Message $message
    } catch {
        # A cancelled or unavailable prompt is a cancellation, not an internal
        # fault, and no authentication was attempted either way.
        return $TOKEN_CANCELLED
    }

    if ($null -eq $script:Credential) { return $TOKEN_CANCELLED }
    # A different username means the required credential was not supplied, so no
    # authentication attempt is made and no process is started.
    if ($script:Credential.UserName -ne $TARGET_USER) { return $TOKEN_CANCELLED }
    if ($null -eq $script:Credential.Password) { return $TOKEN_CANCELLED }
    if ($script:Credential.Password.Length -eq 0) { return $TOKEN_CANCELLED }

    # ---- 4. child process, fully isolated -----------------------------------
    $script:Psi = New-Object System.Diagnostics.ProcessStartInfo
    $script:Psi.FileName               = $PSQL_PATH
    $script:Psi.Arguments              = $commandLine
    $script:Psi.UseShellExecute        = $false
    $script:Psi.RedirectStandardOutput = $true
    $script:Psi.RedirectStandardError  = $true
    $script:Psi.RedirectStandardInput  = $false
    $script:Psi.CreateNoWindow         = $true
    $script:Psi.WorkingDirectory       = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

    # Strip every other route the child could take to a database or credential.
    foreach ($v in @('PGPASSFILE','PGSERVICE','PGSERVICEFILE','PGHOST','PGPORT',
                     'PGDATABASE','PGUSER','DATABASE_URL','TEST_DATABASE_URL')) {
        if ($script:Psi.Environment.ContainsKey($v)) { [void]$script:Psi.Environment.Remove($v) }
    }

    # ---- 5. SecureString -> plaintext, for the shortest possible window -----
    $script:Bstr  = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($script:Credential.Password)
    $script:Plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($script:Bstr)
    $script:Psi.Environment['PGPASSWORD'] = $script:Plain

    # ---- 6. exactly one process, no retry -----------------------------------
    try {
        $script:Proc = [System.Diagnostics.Process]::Start($script:Psi)
    } catch {
        return $TOKEN_START_FAILED
    }
    if ($null -eq $script:Proc) { return $TOKEN_START_FAILED }

    # Read both streams asynchronously so a full pipe cannot deadlock the wait.
    $stdoutTask = $script:Proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $script:Proc.StandardError.ReadToEndAsync()

    if (-not $script:Proc.WaitForExit($TIMEOUT_MS)) {
        try { $script:Proc.Kill() } catch { }
        try { [void]$script:Proc.WaitForExit(5000) } catch { }
        return $TOKEN_TIMEOUT
    }

    # A faulted stream task must not be mistaken for a cleanup problem.
    $stdout = ''
    try { $stdout = $stdoutTask.Result } catch { $stdout = '' }
    try { [void]$stderrTask.Result } catch { }   # drained, never inspected

    $exitCode = -1
    try { $exitCode = $script:Proc.ExitCode } catch { return $TOKEN_START_FAILED }

    # ---- 7. classify, using fixed tokens only -------------------------------
    if ($exitCode -ne 0) { return $TOKEN_REJECTED }

    $trimmed = ($stdout -replace "`r", '').Trim()
    if ($trimmed -eq $TOKEN_VALID)   { return $TOKEN_VALID }
    if ($trimmed -eq $TOKEN_INVALID) { return $TOKEN_INVALID }

    return $TOKEN_OUTPUT_INVALID
}

# ============================================================================
# Single entry point. One token out, one exit, and they cannot disagree.
# ============================================================================

$result              = $null
$secretCleanupFailed = $false

try {
    $result = Invoke-AuthProbe
}
catch {
    # An unexpected failure is an internal error. It is NOT a cleanup failure,
    # and saying so was the defect this phase repairs. No exception detail, no
    # message, no stack, no SQLSTATE ever escapes.
    $result = $TOKEN_INTERNAL_ERROR
}
finally {
    # Every step is independently guarded and idempotent, so one failure cannot
    # skip the rest and nothing can be released twice.
    if ($null -ne $script:Psi) {
        try {
            if ($script:Psi.Environment.ContainsKey('PGPASSWORD')) {
                [void]$script:Psi.Environment.Remove('PGPASSWORD')
            }
        } catch { $secretCleanupFailed = $true }
    }

    if ($script:Bstr -ne [IntPtr]::Zero) {
        try { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($script:Bstr) }
        catch { $secretCleanupFailed = $true }
        $script:Bstr = [IntPtr]::Zero
    }

    $script:Plain = $null

    # Disposing the process is housekeeping, not secret destruction, so a
    # failure here is swallowed and cannot mask the authentication answer.
    if ($null -ne $script:Proc) {
        try { $script:Proc.Dispose() } catch { }
        $script:Proc = $null
    }

    $script:Credential = $null
    $script:Psi        = $null
    [System.GC]::Collect()
}

# A missing or unrecognised result — including stray output contaminating the
# return value — is an internal error, never a silent pass.
if ($null -eq $result -or $ALL_TOKENS -notcontains $result) {
    $result = $TOKEN_INTERNAL_ERROR
}

# Only a genuine failure to destroy the secret may override the outcome.
if ($secretCleanupFailed) { $result = $TOKEN_CLEANUP_FAILED }

Write-Output $result
if ($result -eq $TOKEN_VALID) { exit 0 }
exit 1
