$ErrorActionPreference = 'Stop'

$installDirectory = [Environment]::GetEnvironmentVariable('FOG_COMPANION_INSTALL_DIR', 'Process')
$installUserSid = [Environment]::GetEnvironmentVariable('FOG_COMPANION_INSTALL_USER_SID', 'Process')

if ([string]::IsNullOrWhiteSpace($installDirectory) -or [string]::IsNullOrWhiteSpace($installUserSid)) {
  throw 'Installer directory or user identity was not supplied.'
}

$directory = [System.IO.Directory]::CreateDirectory($installDirectory)
$identity = [System.Security.Principal.SecurityIdentifier]::new($installUserSid)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$accessType = [System.Security.AccessControl.AccessControlType]::Allow
$rights = [System.Security.AccessControl.FileSystemRights]::Modify
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $identity,
  $rights,
  $inheritance,
  $propagation,
  $accessType
)

$acl = Get-Acl -LiteralPath $directory.FullName
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $directory.FullName -AclObject $acl
