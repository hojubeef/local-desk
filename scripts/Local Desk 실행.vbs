Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
settingsPath = rootDir & "\local\local-desk-settings.json"
batPath = scriptDir & "\Local Desk 실행.bat"

showConsole = False
If fso.FileExists(settingsPath) Then
    Set file = fso.OpenTextFile(settingsPath, 1, False, -1)
    settingsText = LCase(file.ReadAll)
    file.Close
    If InStr(settingsText, """showconsole"": true") > 0 Then
        showConsole = True
    End If
End If

If Not fso.FileExists(batPath) Then
    MsgBox "Local Desk 실행.bat를 찾을 수 없습니다." & vbCrLf & batPath, vbExclamation, "Local Desk"
    WScript.Quit 1
End If

shell.CurrentDirectory = rootDir
command = """" & batPath & """"
windowStyle = 0
If showConsole Then
    windowStyle = 1
Else
    command = command & " --no-pause"
End If

shell.Run command, windowStyle, False
