@echo off
node "%~dp0node_modules\typescript\lib\tsc.js" -p "%~dp0tsconfig.json"
if errorlevel 1 (
    echo DERLEME HATASI
    pause
    exit /b 1
)
xcopy /Y /Q "%~dp0out\*" "C:\Users\recne\.vscode\extensions\sencercetinturk.chainforge-1.0.0\out\"
echo.
echo OK - Simdi VS Code'da Ctrl+Shift+P - Developer: Reload Window yap
pause
