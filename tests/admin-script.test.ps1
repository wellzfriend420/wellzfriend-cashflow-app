$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../tools/create-admin.ps1'
$bytes = [IO.File]::ReadAllBytes($scriptPath)
if (@($bytes | Where-Object { $_ -gt 127 }).Count) { throw 'Script must be ASCII-only' }
$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Parser check failed' }

# Stop at the input boundary: no password is created or read, and no SSH runs.
$testState = @{ promptReached = $false; sshReached = $false }
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  if (-not $AsSecureString) { throw 'Input must be hidden' }
  $testState.promptReached = $true
  throw 'INPUT_BOUNDARY_TEST_STOP'
}
function ssh {
  $testState.sshReached = $true
  throw 'SSH_MUST_NOT_RUN'
}
try {
  & $scriptPath -SshTarget 'unused.invalid' -IdentityFile 'unused-key' -Username 'admin'
  throw 'Expected input boundary stop'
} catch {
  if ($_.Exception.Message -ne 'INPUT_BOUNDARY_TEST_STOP') { throw }
}
if (-not $testState.promptReached -or $testState.sshReached) { throw 'Unsafe or incomplete smoke test' }
$testState.promptReached = $false
try {
  & $scriptPath -SshTarget 'unused.invalid' -IdentityFile 'unused-key' -Username '!'
  throw 'Expected username validation'
} catch {
  if ($_.Exception.Message -ne 'Invalid username') { throw }
}
if ($testState.promptReached -or $testState.sshReached) { throw 'Validation must precede input and SSH' }
Write-Output ('PASS PowerShell ' + $PSVersionTable.PSVersion + ': ASCII, parser, hidden-input boundary, validation; no password or SSH')
