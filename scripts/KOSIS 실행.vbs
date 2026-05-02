Option Explicit

Dim fso, shell, scriptDir, rootDir, appDir, appPath, bundledPythonw
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
appDir = fso.BuildPath(rootDir, "apps\kosis")
appPath = fso.BuildPath(appDir, "app.py")

If Not fso.FileExists(appPath) Then
    MsgBox "apps\kosis\app.py was not found.", vbExclamation, "KOSIS launcher"
    WScript.Quit 1
End If

shell.CurrentDirectory = appDir

If fso.FileExists(fso.BuildPath(rootDir, ".venv\Scripts\pythonw.exe")) Then
    If TryRun(shell, Q(fso.BuildPath(rootDir, ".venv\Scripts\pythonw.exe")) & " " & Q(appPath)) Then WScript.Quit 0
End If

If fso.FileExists(fso.BuildPath(rootDir, "venv\Scripts\pythonw.exe")) Then
    If TryRun(shell, Q(fso.BuildPath(rootDir, "venv\Scripts\pythonw.exe")) & " " & Q(appPath)) Then WScript.Quit 0
End If

If fso.FileExists(fso.BuildPath(appDir, ".venv\Scripts\pythonw.exe")) Then
    If TryRun(shell, Q(fso.BuildPath(appDir, ".venv\Scripts\pythonw.exe")) & " " & Q(appPath)) Then WScript.Quit 0
End If

If fso.FileExists(fso.BuildPath(appDir, "venv\Scripts\pythonw.exe")) Then
    If TryRun(shell, Q(fso.BuildPath(appDir, "venv\Scripts\pythonw.exe")) & " " & Q(appPath)) Then WScript.Quit 0
End If

bundledPythonw = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\pythonw.exe"
If fso.FileExists(bundledPythonw) Then
    If TryRun(shell, Q(bundledPythonw) & " " & Q(appPath)) Then WScript.Quit 0
End If

If TryRun(shell, "pyw.exe -3 " & Q(appPath)) Then WScript.Quit 0
If TryRun(shell, "pythonw.exe " & Q(appPath)) Then WScript.Quit 0
If TryRun(shell, "py.exe -3 " & Q(appPath)) Then WScript.Quit 0
If TryRun(shell, "python.exe " & Q(appPath)) Then WScript.Quit 0

MsgBox "Python was not found. Try running the debug BAT file in this folder.", vbExclamation, "KOSIS launcher"

Function Q(value)
    Q = Chr(34) & value & Chr(34)
End Function

Function TryRun(shellObject, command)
    On Error Resume Next
    Err.Clear
    shellObject.Run command, 0, False
    TryRun = (Err.Number = 0)
    On Error GoTo 0
End Function
