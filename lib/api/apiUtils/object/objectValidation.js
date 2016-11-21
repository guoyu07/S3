import { errors } from 'arsenal';
import { isObjAuthorized } from '../authorization/aclChecks';

export default function (params, bucket, data, canonicalID, cb) {
    const { requestType, bucketName, log } = params;
    const obj = data.obj ? JSON.parse(data.obj) : undefined;
    if (!obj) {
        log.trace('found bucket in metadata', { bucketName });
        return cb(null, bucket, obj);
    }
    // TODO: Add bucket policy and IAM checks
    if (!isObjAuthorized(bucket, obj, requestType, canonicalID)) {
        log.debug('access denied for user on object',
        { requestType });
        return cb(errors.AccessDenied);
    }
    log.trace('found object in metadata');
    return cb(null, bucket, obj);
}
