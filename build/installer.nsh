; Premation's additions to electron-builder's NSIS installer (electron-builder.yml nsis.include).

; Claude for Premation (docs/MCP_PLAN.md D9). On a REAL uninstall — not the
; uninstall an auto-update runs before installing the new version — ask the app
; to remove `mcpServers.premation` from Claude Desktop's config, so Claude is
; not left launching a program that no longer exists. Runs before the files are
; deleted; the app edits only its own entry and exits. A failure is ignored: an
; uninstall must never stop on this.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --premation-mcp-uninstall'
  ${endIf}
!macroend
