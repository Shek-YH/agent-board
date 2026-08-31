; electron-builder's installer normally passes /updated to the old
; uninstaller. Older installers then try to Rename their install tree into
; $PLUGINSDIR\old-install, which fails when the install and temp drives differ.
!ifndef BUILD_UNINSTALLER
Var /GLOBAL ABUninstallString
Var /GLOBAL ABInstallationDir
Var /GLOBAL ABUninstallerPath
Var /GLOBAL ABUninstallResult
Var /GLOBAL ABInstallModeArg

; Remove a registered previous version before electron-builder's standard
; upgrade hook runs. Omitting /updated selects the old installer's in-place
; removal path, while /KEEP_APP_DATA preserves Electron user data.
!macro customInit
  ReadRegStr $ABUninstallString SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString

  ${if} $ABUninstallString != ""
    Push $ABUninstallString
    Call GetInQuotes
    Pop $ABUninstallerPath

    ${if} ${FileExists} "$ABUninstallerPath"
      ReadRegStr $ABInstallationDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${if} $ABInstallationDir == ""
        Push $ABUninstallerPath
        Call GetFileParent
        Pop $ABInstallationDir
      ${endIf}

      ${if} $ABInstallationDir != ""
        ${if} $installMode == "all"
          StrCpy $ABInstallModeArg "/allusers"
        ${else}
          StrCpy $ABInstallModeArg "/currentuser"
        ${endIf}
        ExecWait '"$ABUninstallerPath" /S /KEEP_APP_DATA $ABInstallModeArg _?=$ABInstallationDir' $ABUninstallResult
      ${endIf}
    ${endIf}
  ${endIf}
!macroend
!endif

; The default electron-builder update uninstaller atomically renames the old
; install tree into $PLUGINSDIR\old-install. That fails when the application
; and the Windows temp directory are on different volumes.
; Delete the old tree in place instead; the copied updater uninstaller runs
; outside $INSTDIR, so the operation is safe across drive letters.
!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend
