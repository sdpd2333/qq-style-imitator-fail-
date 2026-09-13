@echo off
setlocal
chcp 65001 >nul
title 土豆纪念账号

cd /d "%~dp0"

echo [准备] 正在创建或更新纪念账号配置...
node src\cli.js memorial create --id memorial-example --name "土豆" --subject-qq 1986663148 --group 1060255026 --disclosure "这是纪念账号生成的回复，不代表本人。" --actor startup
node src\cli.js memorial authorize --id memorial-example --actor startup --reason "本地启动"
node src\cli.js memorial enable --id memorial-example --actor startup --confirm

echo.
echo [启动] 管理界面: http://127.0.0.1:3080
echo [启动] 纪念账号: 自主参与模式
start "土豆纪念账号 - 管理界面" cmd /k "npm run web"
start "土豆纪念账号 - 自主参与" cmd /k "npm run run -- --id memorial-example --mode conservative_auto"

echo.
echo 已启动两个服务窗口。此窗口可以关闭。
pause
exit /b 0

:error
echo.
echo [错误] 启动失败，请保留此窗口中的错误信息。
pause
exit /b 1
