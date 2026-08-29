@echo off
setlocal

echo Installing RESTOMAP Python worker dependencies...
echo.

python --version
if errorlevel 1 (
  echo Python was not found. Install Python 3 and enable "Add Python to PATH".
  pause
  exit /b 1
)

python -m pip install --upgrade pip
if errorlevel 1 (
  echo Failed to upgrade pip.
  pause
  exit /b 1
)

python -m pip install requests schedule
if errorlevel 1 (
  echo Failed to install worker dependencies.
  pause
  exit /b 1
)

echo.
echo Worker dependencies installed successfully.
echo.
echo Start the backend with:
echo node server.js
echo.
echo Check the filename carefully: server.js, not server.sj.
pause
