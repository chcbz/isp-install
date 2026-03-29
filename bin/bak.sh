#!/bin/sh
DATE=$(date +%Y%m%d)
cd /home
find /data -mtime +90 -type f -name \*.tgz -exec rm -f {} \;
tar -czf /data/oa_$DATE.tgz oa
