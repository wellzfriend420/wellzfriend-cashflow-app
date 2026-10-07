param(
  [Parameter(Mandatory=$true)][string]$SshTarget,
  [Parameter(Mandatory=$true)][string]$IdentityFile,
  [string]$Username = 'admin'
)
$ErrorActionPreference = 'Stop'
$previousOutputEncoding = $OutputEncoding
$OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Username -notmatch '^[A-Za-z0-9_.-]{3,40}$') { throw 'Invalid username' }
# Keep this script ASCII-only for Windows PowerShell 5.1 without a UTF-8 BOM.
$securePassword = Read-Host 'Initial admin password (12-256 characters; input is hidden)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ($plainPassword.Length -lt 12 -or $plainPassword.Length -gt 256 -or $plainPassword.Contains("`n")) { throw 'Password must be 12 to 256 characters, without newlines' }
  $plainPassword | & ssh -i $IdentityFile -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no $SshTarget "docker compose --project-directory /opt/wfs/cashflow exec -T cashflow-web node tools/admin.cjs $Username"
  if ($LASTEXITCODE -ne 0) { throw 'Admin creation failed' }
} finally {
  $plainPassword = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $securePassword.Dispose()
  $OutputEncoding = $previousOutputEncoding
}
