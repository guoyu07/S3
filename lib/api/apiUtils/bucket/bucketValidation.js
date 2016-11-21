import { errors } from 'arsenal';
import BucketInfo from '../../../metadata/BucketInfo';
import bucketShield from './bucketShield';
import { isBucketAuthorized } from '../authorization/aclChecks';

export default function (params, data, canonicalID, cb) {
    const { bucketName, requestType, log } = params;
    log.trace('performing metadata bucket validation checks');

    const bucket = data.bucket ?
        BucketInfo.deSerialize(data.bucket) : undefined;

    if (!bucket) {
        log.debug('bucketAttrs is undefined', {
            bucket: bucketName,
            method: 'bucketValidation',
        });
        return cb(errors.NoSuchBucket);
    }
    if (bucketShield(bucket, requestType)) {
        log.debug('no such bucket', { requestType });
        return cb(errors.NoSuchBucket);
    }
    if (!isBucketAuthorized(bucket, requestType, canonicalID)) {
        log.debug('access denied for user on bucket',
        { requestType });
        return cb(errors.AccessDenied);
    }
    return cb(null, bucket, data);
}
