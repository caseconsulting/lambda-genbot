# lambda-genbot

GenBot is a Basecamp chatbot that generates an image from a text prompt.

1. A Basecamp chat command sends the prompt to the **genbot** function through an API Gateway HTTP API (`POST /`).
2. **genbot** checks that the request comes from the CASE Basecamp account, adds a random style to the prompt, and generates a JPEG with the Amazon Bedrock Stability AI Stable Image Core model (in us-west-2).
3. **genbot** saves the image to an S3 bucket (in us-east-1) and replies to Basecamp with a link to the **genbot-retrieve** function.
4. **genbot-retrieve** (a Lambda Function URL) reads the image from S3 and returns it with long-lived cache headers. Older images in the bucket are PNG; newer ones are JPEG.

Images in the bucket expire after about 6 months. Basecamp serves old chat images from its own stored copy, so opening an image in Basecamp doesn't call **genbot-retrieve**.

The project is built and deployed with the AWS SAM CLI.

## Files

- generate.js - Code for the genbot function.
- retrieve.js - Code for the genbot-retrieve function.
- constants.js - Constants shared by both functions (region, bucket name, error image).
- template.yaml - SAM template that defines the AWS resources: both Lambda functions and their IAM roles, the HTTP API, the Function URL, the S3 images bucket, and CloudWatch log groups.
- package.json - Dependencies, npm scripts, and the `files` list that limits what is packaged into each function.
- event-generate.json - Sample event for invoking genbot locally.
- event-retrieve.json - Sample event for invoking genbot-retrieve locally.
- test/ - Unit tests.
- PLAN.md - Design notes and measurements from the move to Stable Image Core.
- FEEDBACK.md - Code review findings and how each was resolved.

## Prerequisites

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), configured for SSO (see below).
- [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html).
- [Node.js](https://nodejs.org/en/) 24, matching the Lambda runtime.
- [Docker](https://docs.docker.com/get-docker/), only for running functions locally with `sam local`. Building, testing, and deploying don't need it.

The deployed stack also relies on:

- **Bedrock model access** to Stable Image Core in us-west-2.
- **SSM parameter `/Basecamp/CompanyID`**, the Basecamp company ID for which genbot accepts requests.

## AWS SSO Configuration

### AWS Management Account - _mgmt_ Profile

If AWS SSO has not yet been configured, follow instructions in https://github.com/caseconsulting/expense-app-api/blob/master/README.md#aws-sso-configuration to complete initial SSO configuration. **lambda-genbot** is deployed to the CASE Management AWS account, so you need to make sure you've configured a _mgmt_ profile for the _Case Consulting Management_ AWS account.

### AWS SSO Login

To obtain AWS credentials from AWS SSO, run `npm run login` (or `aws sso login --profile mgmt`).
Your web browser should open a new tab, where you should be required to login to Google with your **@consultwithcase.com**
email address (unless you recently did so) and then press the _Allow_ button to explicitly permit the authorize request.

To remove AWS credentials, run `aws sso logout --profile mgmt`. This will also clear any authorization.
Therefore, a subsequent login will launch the web browser again for a new authorization request.

## npm scripts

| Script                   | What it does                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `npm test`               | Runs the unit tests.                                                                    |
| `npm run login`          | Signs in to AWS SSO with the `mgmt` profile.                                            |
| `npm run build`          | Runs `sam build`, writing the deployment packages to `.aws-sam/build`.                  |
| `npm run deploy`         | Builds, then deploys the `lambda-genbot` stack to us-east-1.                            |
| `npm run local:generate` | Builds, then invokes genbot locally with `event-generate.json` (needs Docker).          |
| `npm run local:retrieve` | Builds, then invokes genbot-retrieve locally with `event-retrieve.json` (needs Docker). |
| `npm run clean`          | Removes `.aws-sam/build`. Keeps `.aws-sam/build.toml` and any `--cached` build cache.   |

## Unit tests

Unit tests use the built-in Node.js test runner (`node:test`) and mock all AWS calls, so no credentials are needed.

```bash
npm test
```

## Deploy

Deploy with `npm run deploy`. It runs `sam build`, then `sam deploy` with this project's fixed settings (stack `lambda-genbot`, region us-east-1, the `case-consulting-mgmt-sam-deployments` artifact bucket, and the `mgmt` profile). The project has no `samconfig.toml`, so don't use `sam deploy --guided`.

Preview the change set first. This builds and creates a change set without executing it:

```bash
npm run deploy -- --no-execute-changeset
```

In the change set, check that no resource shows `Replacement: True`. Several resources have fixed names (the bucket, functions, and log groups), so CloudFormation can't replace them in place. Run `aws cloudformation describe-change-set` to see why each property is changing. If the change set looks right, run `npm run deploy`.

To use a different Bedrock model or region, override the template parameters. The function's IAM policy and environment variables both follow these values:

```bash
npm run deploy -- --parameter-overrides BedrockModelId=<model-id> BedrockRegion=<region>
```

After deploying, the output lists the HTTP API endpoint (`GenBotApi`) and the retrieve Function URL (`GenBotRetrieveApi`). Run `npm run clean` to remove the build output.

## Run functions locally

`sam local invoke` runs a function in a Docker container that matches the Lambda runtime. It uses your `mgmt` credentials, so the functions call the real AWS services.

```bash
npm run local:generate
npm run local:retrieve
```

- **genbot** calls Bedrock and writes the image to the production bucket, so each successful local run costs the same as a real request. `sam local` can't resolve `{{resolve:ssm:...}}` references, so the company ID is the literal string `{{resolve:ssm:/Basecamp/CompanyID:1}}`. `event-generate.json` sends that same string so the company-ID check passes. In the deployed function the reference resolves to the real ID, so this string is rejected there. The retrieve link in the reply comes from the Function URL attribute, which `sam local` also can't resolve, so don't expect it to work.
- **genbot-retrieve** reads from the production bucket. `event-retrieve.json` requests `/abc.png`, which doesn't exist, so the function redirects to the error image. To retrieve a real image, copy the event and change `rawPath` and `requestContext.http.path` to an existing key.

You can also emulate the HTTP API on port 3000 with `sam local start-api`. The only route is `POST /`. Start the API in one terminal:

```bash
sam local start-api --profile mgmt
```

In a second terminal, generate an image. The reply is plain text ending in the image file name (`<request-id>.jpg`). The reply's retrieve link doesn't resolve locally, and `start-api` doesn't emulate the Function URL, so get the image from the deployed genbot-retrieve function instead. This step needs [jq](https://jqlang.org/).

```bash
RESPONSE=$(curl -s -X POST http://localhost:3000/ \
  -d '{"command": "monster pizza party", "creator": {"company": {"id": "{{resolve:ssm:/Basecamp/CompanyID:1}}"}}}')
echo "$RESPONSE"

# Extract the image file name; empty if generation failed
IMAGE=$(printf '%s' "$RESPONSE" | jq -Rr 'capture("(?<name>[0-9a-f-]{36}\\.jpg)$").name')

# Download the image from the deployed genbot-retrieve function
RETRIEVE_URL=$(aws cloudformation describe-stacks --stack-name lambda-genbot --region us-east-1 --profile mgmt \
  --query "Stacks[0].Outputs[?OutputKey=='GenBotRetrieveApi'].OutputValue" --output text)
[ -n "$IMAGE" ] && curl -s -o "$IMAGE" "$RETRIEVE_URL$IMAGE" && open "$IMAGE"   # open is macOS; use xdg-open on Linux
```

## Fetch, tail, and filter Lambda function logs

`sam logs` fetches logs from the deployed functions:

```bash
sam logs -n GenBotFunction --stack-name lambda-genbot --tail --profile mgmt
sam logs -n GenBotRetrieveFunction --stack-name lambda-genbot --tail --profile mgmt
```

See the [SAM documentation](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-logging.html) for filtering options.

## Delete the stack

CloudFormation can't delete a bucket that still contains objects. Empty the images bucket first. This permanently deletes every generated image.

```bash
aws s3 rm s3://case-consulting-mgmt-genbot-images --recursive --profile mgmt
aws cloudformation delete-stack --stack-name lambda-genbot --profile mgmt
```

## Resources

- [AWS SAM developer guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)
- [Stable Image Core on Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-image-core-1-0.html)
