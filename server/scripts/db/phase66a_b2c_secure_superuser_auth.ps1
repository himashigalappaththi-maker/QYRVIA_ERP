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

function Write-Result {
    param([string]$Token, [int]$Code)
    Write-Output $Token
    exit $Code
}

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

$plain      = $null
$bstr       = [IntPtr]::Zero
$proc       = $null
$psi        = $null
$credential = $null

try {
    # ---- 1. the executable must be exactly the expected one -----------------
    if (-not (Test-Path -LiteralPath $PSQL_PATH -PathType Leaf)) {
        Write-Result $TOKEN_PSQL_NOT_FOUND 1
    }

    # ---- 2. build the command line from literals only -----------------------
    # This runs BEFORE the credential dialog, so a malformed argument can never
    # reach a point where a password exists in memory.
    try {
        $quoted = foreach ($a in $ARGV) { ConvertTo-SafeArgument -Value $a }
        $commandLine = [string]::Join(' ', $quoted)
    } catch {
        Write-Result $TOKEN_START_FAILED 1
    }

    # ---- 3. capture the credential ------------------------------------------
    $message = 'Local PostgreSQL 18 TEST database only (127.0.0.1:5432/qyrvia_test). ' +
               'Enter the postgres superuser password. It is never displayed, logged or stored.'
    $credential = Get-Credential -UserName $TARGET_USER -Message $message

    if ($null -eq $credential) {
        Write-Result $TOKEN_CANCELLED 1
    }
    # A different username means the required credential was not supplied, so no
    # authentication attempt is made and no process is started.
    if ($credential.UserName -ne $TARGET_USER) {
        Write-Result $TOKEN_CANCELLED 1
    }
    if ($null -eq $credential.Password -or $credential.Password.Length -eq 0) {
        Write-Result $TOKEN_CANCELLED 1
    }

    # ---- 4. child process, fully isolated -----------------------------------
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $PSQL_PATH
    $psi.Arguments              = $commandLine
    $psi.UseShellExecute        = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.RedirectStandardInput  = $false
    $psi.CreateNoWindow         = $true
    $psi.WorkingDirectory       = (Split-Path -Parent (Split-Path -Parent $PSCriptRoot))

    # Strip every other route the child could take to a database or credential.
    foreach ($v in @('PGPASSFILE','PGSERVICE','PGSERVICEFILE','PGHOST','PGPORT',
                     'PGDATABASE','PGUSER','DATABASE_URL','TEST_DATABASE_URL')) {
        if ($psi.Environment.ContainsKey($v)) { [void]$psi.Environment.Remove($v) }
    }

    # ---- 5. SecureString -> plaintext, for the shortest possible window -----
    $bstr  = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
    $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $psi.Environment['PGPASSWORD'] = $plain

    # ---- 6. exactly one process, no retry -----------------------------------
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch {
        Write-Result $TOKEN_START_FAILED 1
    }
    if ($null -eq $proc) {
        Write-Result $TOKEN_START_FAILED 1
    }

    # Read both streams asynchronously so a full pipe cannot deadlock the wait.
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    if (-not $proc.WaitForExit($TIMEOUT_MS)) {
        try { $proc.Kill() } catch { }
        try { [void]$proc.WaitForExit(5000) } catch { }
        Write-Result $TOKEN_TIMEOUT 1
    }

    $stdout = $stdoutTask.Result
    [void]$stderrTask.Result   # consumed so the pipe drains; never inspected
    $exitCode = $proc.ExitCode

    # ---- 7. classify, using fixed tokens only -------------------------------
    if ($exitCode -ne 0) {
        Write-Result $TOKEN_REJECTED 1
    }

    $trimmed = ($stdout -replace "`r", '').Trim()
    if ($trimmed -eq $TOKEN_VALID)   { Write-Result $TOKEN_VALID 0 }
    if ($trimmed -eq $TOKEN_INVALID) { Write-Result $TOKEN_INVALID 1 }

    Write-Result $TOKEN_OUTPUT_INVALID 1
}
catch {
    # No exception detail, no message, no stack, no SQLSTATE ever escapes.
    Write-Output $TOKEN_CLEANUP_FAILED
    exit 1
}
finally {
    $cleanupOk = $true
    if ($null -ne $psi) {
        try { if ($psi.Environment.ContainsKey('PGPASSWORD')) { [void]$psi.Environment.Remove('PGPASSWORD') } }
        catch { $cleanupOk = $false }
    }
    if ($bstr -ne [IntPtr]::Zero) {
        try { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        catch { $cleanupOk = $false }
        $bstr = [IntPtr]::Zero
    }
    $plain = $null
    if ($null -ne $proc) { try { $proc.Dispose() } catch { } }
    $credential = $null
    [System.GC]::Collect()
    if (-not $cleanupOk) { Write-Output $TOKEN_CLEANUP_FAILED }
}
