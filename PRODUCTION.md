# Scality S3server in production with Docker

## Using Docker Volume

in production

S3Server runs with a file backend by default.

So, by default, the data are stored inside your S3server Docker container.

However, you **MUST** use Docker volumes to host the data and the metadata of
the S3server container outside your S3server Docker container.

`docker run -­v $(pwd)/data:/usr/src/app/localData -­v`
`$(pwd)/metadata:/usr/src/app/localMetadata -p 8000:8000 ­-d scality/s3server`

## Adding/ modifying/ deleting accounts/ users credentials

1. Create locally a customized `conf/authdata.json`.

2. Use [Docker Volume](https://docs.docker.com/engine/tutorials/dockervolumes/)

to override the default one through a docker file mapping.

`docker run -v $(pwd)/authdata.json:/usr/src/app/conf/authdata.json -p`
`8000:8000 -d scality/s3server`

## Setting a new region

To specify an host name (e.g. s3.domain.name),
you can provide your own
[config.json](https://github.com/scality/S3/blob/master/config.json)
using [Docker Volume](https://docs.docker.com/engine/tutorials/dockervolumes/).

First, add a new region to your config.json that you created locally:

```json
"regions": {

     ...

     "localregion": ["localhost"],
     "specifiedregion": ["s3.domain.name"]
},
```

Then, run your Scality S3 Server using
[Docker Volume](https://docs.docker.com/engine/tutorials/dockervolumes/):

`docker run -v $(pwd)/config.json:/usr/src/app/config.json -p 8000:8000`
`-d scality/s3server`

Your local `config.json` file will override the default one through a docker
file mapping.
