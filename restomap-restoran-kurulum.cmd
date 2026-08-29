@echo off
setlocal EnableExtensions
chcp 65001 >nul
title RESTOMAP Restoran Kurulumu

set "RESTOMAP_URL=https://deliveraexpres.com.tr/restaurant.html?kiosk=1"
set "BROWSER_EXE="
set "BROWSER_NAME="

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  set "BROWSER_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  set "BROWSER_NAME=Microsoft Edge"
)
if not defined BROWSER_EXE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  set "BROWSER_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  set "BROWSER_NAME=Microsoft Edge"
)
if not defined BROWSER_EXE if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  set "BROWSER_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  set "BROWSER_NAME=Google Chrome"
)
if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  set "BROWSER_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  set "BROWSER_NAME=Google Chrome"
)

if not defined BROWSER_EXE (
  echo HATA: Microsoft Edge veya Google Chrome bulunamadi.
  echo Once Edge ya da Chrome kurup bu dosyayi yeniden calistirin.
  pause
  exit /b 1
)

echo RESTOMAP bildirim izni ayarlaniyor...
reg add "HKCU\Software\Policies\Microsoft\Edge\NotificationsAllowedForUrls" /v 1 /t REG_SZ /d "https://deliveraexpres.com.tr" /f >nul 2>&1
reg add "HKCU\Software\Policies\Google\Chrome\NotificationsAllowedForUrls" /v 1 /t REG_SZ /d "https://deliveraexpres.com.tr" /f >nul 2>&1

set "RESTOMAP_ARGS=--user-data-dir=^"%LOCALAPPDATA%\RestomapRestoranBrowser^" --app=^"%RESTOMAP_URL%^" --kiosk-printing --disable-background-timer-throttling --disable-renderer-backgrounding"
set "DESKTOP_LINK=%USERPROFILE%\Desktop\RESTOMAP Restoran.lnk"
set "STARTUP_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\RESTOMAP Restoran.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($env:DESKTOP_LINK); $s.TargetPath=$env:BROWSER_EXE; $s.Arguments=$env:RESTOMAP_ARGS; $s.WorkingDirectory=(Split-Path $env:BROWSER_EXE); $s.Description='RESTOMAP Restoran Paneli'; $s.Save(); Copy-Item -LiteralPath $env:DESKTOP_LINK -Destination $env:STARTUP_LINK -Force"
if errorlevel 1 (
  echo HATA: RESTOMAP kisayolu olusturulamadi.
  pause
  exit /b 1
)

echo.
echo Kurulum tamamlandi: %BROWSER_NAME%
echo - Bildirimler RESTOMAP icin izinli.
echo - Yeni siparis fisi varsayilan yaziciya otomatik gider.
echo - RESTOMAP Windows acilisinda otomatik baslar.
echo.
echo Simdi RESTOMAP Restoran aciliyor. Ilk acilista bir kez giris yapin.
start "" "%DESKTOP_LINK%"
timeout /t 4 /nobreak >nul
exit /b 0
