# lambda-genbot

This project contains source code and supporting files for a serverless application that you can deploy with the SAM CLI. It includes the following files and folders.

- generate.js - Code for the GenBot Lambda function.
- event-generate.json - Sample event that you can use to invoke the GenBot function.
- retrieve.js - Code for the GenBot Retrieve Lambda function.
- event-retrieve.json - Sample event that you can use to invoke the GenBot Retrieve function.
- template.yaml - A template that defines the AWS resources for the GenBot and GenBot Retrieve functions.

The application uses several AWS resources, including Lambda functions and IAM Roles. These resources are defined in the `template.yaml` file in this project. You can update the templates to add AWS resources through the same deployment process that updates your application code.

## AWS SSO Configuration

### AWS Management Account - _mgmt_ Profile

If AWS SSO has not yet been configured, follow instructions in https://github.com/caseconsulting/expense-app-api/blob/master/README.md#aws-sso-configuration to complete initial SSO configuration. **lambda-genbot** is deployed to the CASE Management AWS account, so you need to make sure you've configured a _mgmt_ profile for the _Case Consulting Management_ AWS account.

### AWS SSO Login

To explicitly obtain AWS credentials from AWS SSO, run `aws sso login --profile mgmt`.
Your web browser should open a new tab, where you should be required to login to Google with your **@consultwithcase.com**
email address (unless you recently did so) and then press the _Allow_ button to explicitly permit the authorize request.

To remove AWS credentials, run `aws sso logout --profile mgmt`. This will also clear any authorization.
Therefore, a subsequent login will launch the web browser again for a new authorization request.

## Deploy the sample application

The Serverless Application Model Command Line Interface (SAM CLI) is an extension of the AWS CLI that adds functionality for building and testing Lambda applications. It uses Docker to run your functions in an Amazon Linux environment that matches Lambda. It can also emulate your application's build environment and API.

To use the SAM CLI, you need the following tools.

- SAM CLI - [Install the SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html)
- Node.js - [Install Node.js](https://nodejs.org/en/), including the NPM package management tool.
- Docker - [Install Docker community edition](https://hub.docker.com/search/?type=edition&offering=community)

To build and deploy your application for the first time, run the following in your shell:

```bash
sam build
sam deploy --guided
```

The first command will build the source of your application. The second command will package and deploy your application to AWS, with a series of prompts:

- **Stack Name**: The name of the stack to deploy to CloudFormation. This should be unique to your account and region, and a good starting point would be something matching your project name.
- **AWS Region**: The AWS region you want to deploy your app to.
- **Confirm changes before deploy**: If set to yes, any change sets will be shown to you before execution for manual review. If set to no, the AWS SAM CLI will automatically deploy application changes.
- **Allow SAM CLI IAM role creation**: Many AWS SAM templates, including this example, create AWS IAM roles required for the AWS Lambda function(s) included to access AWS services. By default, these are scoped down to minimum required permissions. To deploy an AWS CloudFormation stack which creates or modified IAM roles, the `CAPABILITY_IAM` value for `capabilities` must be provided. If permission isn't provided through this prompt, to deploy this example you must explicitly pass `--capabilities CAPABILITY_IAM` to the `sam deploy` command.
- **Save arguments to samconfig.toml**: If set to yes, your choices will be saved to a configuration file inside the project, so that in the future you can just re-run `sam deploy` without parameters to deploy changes to your application.

You can find your API Gateway Endpoint URL in the output values displayed after deployment.

## Use the SAM CLI to build and test locally

Build your application with the `sam build` command.

```bash
sam build
```

The SAM CLI installs dependencies defined in `package.json`, creates a deployment package, and saves it in the `.aws-sam/build` folder.

Test a single function by invoking it directly with a test event. An event is a JSON document that represents the input that the function receives from the event source.

Run functions locally and invoke them with the `sam local invoke` command.

```bash
sam local invoke GenBotFunction -e event-generate.json --profile mgmt
sam local invoke GenBotRetrieveFunction -e event-retrieve.json --profile mgmt
```

The SAM CLI can also emulate your application's API. Use the `sam local start-api` to run the API locally on port 3000.

```bash
sam local start-api
curl http://localhost:3000/
```

The SAM CLI reads the application template to determine the API's routes and the functions that they invoke. The `Events` property on each function's definition includes the route and method for each path.

```yaml
Events:
  GenBot:
    Type: HttpApi
    Properties:
      Path: /
      Method: post
```

## Add a resource to your application

The application template uses AWS Serverless Application Model (AWS SAM) to define application resources. AWS SAM is an extension of AWS CloudFormation with a simpler syntax for configuring common serverless application resources such as functions, triggers, and APIs. For resources not included in [the SAM specification](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-specification-resources-and-properties.html), you can use standard [AWS CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html) resource types.

## Fetch, tail, and filter Lambda function logs

To simplify troubleshooting, SAM CLI has a command called `sam logs`. `sam logs` lets you fetch logs generated by your deployed Lambda function from the command line. In addition to printing the logs on the terminal, this command has several nifty features to help you quickly find the bug.

`NOTE`: This command works for all AWS Lambda functions; not just the ones you deploy using SAM.

```bash
sam logs -n GenBotFunction --stack-name lambda-genbot --tail --profile mgmt
sam logs -n GenBotRetrieveFunction --stack-name lambda-genbot --tail --profile mgmt
```

You can find more information and examples about filtering Lambda function logs in the [SAM Documentation](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-logging.html).

## Cleanup

To delete the application, use the AWS CLI and run the following:

```bash
aws cloudformation delete-stack --stack-name lambda-genbot --profile mgmt
```

## Resources

See the [AWS SAM developer guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) for an introduction to SAM specification, the SAM CLI, and serverless application concepts.

Next, you can use AWS Serverless Application Repository to deploy ready to use Apps that go beyond samples and learn how authors developed their applications: [AWS Serverless Application Repository main page](https://aws.amazon.com/serverless/serverlessrepo/)
