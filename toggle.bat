@echo off
rem toggle the discord-listening presence on/off (windows equivalent of toggle.sh;
rem the script picks the change up from the off-file within its 2s poll)
set "f=%USERPROFILE%\.discord-listening-off"
if exist "%f%" (
  del "%f%"
  echo listening presence ON
) else (
  type nul > "%f%"
  echo listening presence OFF
)