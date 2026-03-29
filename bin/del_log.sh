#!/bin/sh
find /home/isp/apps/tomcat1/logs/ -mtime +30 -name "*.log" -exec rm -rf {} \;
find /usr/logs/ -mtime +30 -name "*.log" -exec rm -rf {} \;
