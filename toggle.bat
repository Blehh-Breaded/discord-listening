@echo off
rem toggle the discord-listening presence on/off (windows equivalent of toggle.sh;
rem the script watches this file, so it applies instantly)
set "f=%USERPROFILE%\.discord-listening-off"
if exist "%f%" (
  del "%f%"
  echo listening presence ON
) else (
  type nul > "%f%"
  echo listening presence OFF
)