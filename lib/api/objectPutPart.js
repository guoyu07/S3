import assert from 'assert';
import async from 'async';
import { errors } from 'arsenal';

import services from '../services';
import constants from '../../constants';
import kms from '../kms/wrapper';
import metadata from '../metadata/wrapper';
import { isMpuAuthorized } from '../api/apiUtils/authorization/aclChecks';
import validateObject from '../api/apiUtils/object/objectValidation';
import validateBucket from '../api/apiUtils/bucket/bucketValidation';

function _getPaddedPartNumber(number) {
    return `000000${number}`.substr(-5);
}
/**
 * PUT part of object during a multipart upload. Steps include:
 * validating metadata for authorization, bucket existence
 * and multipart upload initiation existence,
 * store object data in datastore upon successful authorization,
 * store object location returned by datastore in metadata and
 * return the result in final cb
 *
 * @param {AuthInfo} authInfo - Instance of AuthInfo class with requester's info
 * @param {object} request - request object
 * @param {object | undefined } streamingV4Params - if v4 auth,
 * object containing accessKey, signatureFromRequest, region, scopeDate,
 * timestamp, and credentialScope
 * (to be used for streaming v4 auth if applicable)
 * @param {object} log - Werelogs logger
 * @param {function} cb - final callback to call with the result
 * @return {undefined}
 */
export default function objectPutPart(authInfo, request, streamingV4Params, log,
    cb) {
    log.debug('processing request', { method: 'objectPutPart' });

    const bucketName = request.bucketName;
    const objectKey = request.objectKey;
    const size = request.parsedContentLength;
    const partNumber = Number.parseInt(request.query.partNumber, 10);

    // AWS caps partNumbers at 10,000
    if (partNumber > 10000) {
        return cb(errors.TooManyParts);
    }

    if (!Number.isInteger(partNumber) || partNumber < 1) {
        return cb(errors.InvalidArgument);
    }

    // If part size is greater than 5GB, reject it
    if (Number.parseInt(size, 10) > 5368709120) {
        return cb(errors.EntityTooLarge);
    }

    // Note: Parts are supposed to be at least 5MB except for last part.
    // However, there is no way to know whether a part is the last part
    // since keep taking parts until get a completion request.  But can
    // expect parts of at least 5MB until last part.  Also, we check that
    // part sizes are large enough when mutlipart upload completed.

    // Note that keys in the query object retain their case, so
    // request.query.uploadId must be called with that exact
    // capitalization
    const uploadId = request.query.uploadId;
    const metadataValMPUparams = {
        authInfo,
        bucketName,
        objectKey,
        uploadId,
        requestType: 'putPart or complete',
        log,
        splitter: constants.splitter,
    };

    // For validating the request at the destinationBucket level
    // params are the same as validating at the MPU level
    // but the requestType is the more general 'objectPut'
    const metadataValParams = Object.assign({}, metadataValMPUparams);
    metadataValParams.requestType = 'objectPut';

    log.trace('owner canonicalid to send to data', {
        canonicalID: authInfo.getCanonicalID,
    });
    const objectKeyContext = {
        bucketName,
        owner: authInfo.getCanonicalID(),
        namespace: request.namespace,
    };

    const { requestType } = metadataValParams;
    const mpuBucketName = `${constants.mpuBucketPrefix}${bucketName}`;

    const canonicalID = authInfo.getCanonicalID();
    assert.strictEqual(typeof bucketName, 'string');
    assert.strictEqual(typeof canonicalID, 'string');

    function validateMPU(mpuBucketName, mpuBucket, cb) {
        // BACKWARD COMPAT: Remove to remove the old splitter
        const splitter = mpuBucket.getMdBucketModelVersion() < 2 ?
            constants.oldSplitter : constants.splitter;

        const searchArgs = {
            prefix:
            `overview${splitter}${objectKey}${splitter}${uploadId}`,
            marker: undefined,
            delimiter: undefined,
            maxKeys: 1,
        };
        metadata.listObject(mpuBucketName, searchArgs, log, (err, res) => {
            if (err) {
                log.error('error from metadata', { error: err });
                return cb(err);
            }
            if (res.Contents.length !== 1) {
                return cb(errors.NoSuchUpload);
            }
            const storedValue = res.Contents[0].value;
            const initiatorID = storedValue.Initiator.ID;
            const ownerID = storedValue.Owner.ID;
            if (!isMpuAuthorized(mpuBucket, authInfo, initiatorID,
                ownerID, requestType)) {
                return cb(errors.AccessDenied);
            }
            return cb();
        });
    }

    return async.waterfall([
        // main bucket acl check
        next => metadata.getBucketAndObjectMD(bucketName, objectKey, log, next),
        (data, next) =>
            validateBucket(metadataValParams, data, canonicalID, next),
        (bucket, data, next) =>
            validateObject(metadataValParams, bucket, data, canonicalID, next),
        // multipart bucket acl check
        (bucket, pass, next) =>
            metadata.getBucket(mpuBucketName, log, (err, mpuBucket) => {
                if (err) {
                    log.error('error from metadata', { error: err });
                    return next(errors.NoSuchUpload);
                }
                return next(null, bucket, mpuBucket, next);
            }),
        (bucket, mpuBucket, next) => {
            validateMPU(mpuBucketName, mpuBucket, err => {
                next(err, bucket, mpuBucket);
            });
        },
        (bucket, mpuBucket, next) => {
            const serverSideEncryption = bucket.getServerSideEncryption();
            if (serverSideEncryption) {
                return kms.createCipherBundle(serverSideEncryption, log,
                    (err, cipherBundle) =>
                    next(err, mpuBucket, cipherBundle));
            }
            return next(null, mpuBucket, null);
        },
        // store in data backend
        (mpuBucket, cipherBundle, next) =>
            services.dataStore(null, objectKeyContext, cipherBundle, request,
                size, streamingV4Params, log,
                (err, extraArg, dataGetInfo, hexDigest) => next(err, mpuBucket,
                    cipherBundle, dataGetInfo, hexDigest)),
        // store data locations in metadata
        (mpuBucket, cipherBundle, dataGetInfo, hexDigest, next) => {
            // BACKWARD COMPAT: Remove to remove the old splitter
            const splitter = mpuBucket.getMdBucketModelVersion() < 2 ?
                constants.oldSplitter : constants.splitter;

            // To be consistent with objectPutCopyPart where there could be
            // multiple locations, use an array here.
            const dataGetInfoArr = [dataGetInfo];
            if (cipherBundle) {
                const { algorithm, masterKeyId, cryptoScheme, cipheredDataKey }
                    = cipherBundle;
                dataGetInfoArr[0].sseAlgorithm = algorithm;
                dataGetInfoArr[0].sseMasterKeyId = masterKeyId;
                dataGetInfoArr[0].sseCryptoScheme = cryptoScheme;
                dataGetInfoArr[0].sseCipheredDataKey = cipheredDataKey;
            }

            const mdParams = {
                // We pad the partNumbers so that the parts will be sorted
                // in numerical order
                partNumber: _getPaddedPartNumber(partNumber),
                contentMD5: hexDigest,
                size,
                uploadId,
                splitter,
            };
            services.metadataStorePart(mpuBucket.getName(), dataGetInfoArr,
                mdParams, log, err => next(err, hexDigest));
        },
    ], (err, hexDigest) => {
        if (err) {
            log.error('error in object put part (upload part)', {
                error: err,
                method: 'objectPutPart',
            });
            return cb(err);
        }
        return cb(null, hexDigest);
    });
}
