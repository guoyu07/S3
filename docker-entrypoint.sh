#!/bin/bash

# set -e stops the execution of a script if a command or pipeline has an error
set -e

if [[ "$ACCESS_KEY" && "$SECRET_KEY" ]]; then
  sed -i "s/accessKey1/$ACCESS_KEY/" ./conf/authdata.json
  sed -i "s/verySecretKey1/$SECRET_KEY/" ./conf/authdata.json
  echo "access key and secret key have been modified successfuly"
fi

if [[ "$HOST_NAME" ]]; then
  sed -i "s/s3.docker.test/$HOST_NAME/" ./config.json
  echo "host name has been modified successfuly"
fi

exec "$@"
