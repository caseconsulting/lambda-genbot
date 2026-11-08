// Shared by the genbot (generate.js) and genbot-retrieve (retrieve.js) functions

// Lambda functions and S3 bucket live in us-east-1
export const REGION = 'us-east-1';

// Must match GenBotImagesBucket's BucketName in template.yaml. Not passed as an env var from !Ref, because
// `sam local` resolves !Ref of a resource to its logical ID ('GenBotImagesBucket'), not the bucket name.
export const BUCKET_NAME = 'case-consulting-mgmt-genbot-images';

// Shown (generate) or redirected to (retrieve) when something goes wrong
export const ERROR_IMAGE_URL = 'https://media.giphy.com/media/l41JNsXAvFvoHvWJW/giphy.gif';
