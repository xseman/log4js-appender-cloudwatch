# log4js appender - AWS CloudWatch

This module provides a custom appender for [log4js][log4js_github] that
sends logs to AWS [CloudWatch][aws_cloudwatch] using the AWS [v3 SDK][cloudwatch_sdk].

<img src="docs/visual.svg" alt="visual" width="400px">

[aws_cloudwatch]: https://aws.amazon.com/cloudwatch/
[cloudwatch_sdk]: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cloudwatch-logs/
[log4js_github]: https://log4js-node.github.io/log4js-node/

## Installation

### npm registry

```sh
npm install log4js-appender-cloudwatch
```

## Configuration

### Roles

**Required**

```plain
logs:PutLogEvents
```

**To enable the appender to create a group and log stream in AWS, adition roleare
required.**

```plain
logs:PutLogEvents
logs:CreateLogGroup
logs:CreateLogStream
logs:DescribeLogStreams
logs:DescribeLogGroups
```

**Reqired for testing.**

To run tests, create `.env` with AWS access and secret keys.

```plain
logs:PutLogEvents
logs:GetLogEvents
```

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Action": [
				"logs:PutLogEvents",
				"logs:GetLogEvents"
			],
			"Effect": "Allow",
			"Resource": "*"
		}
	]
}
```

### TypeScript

If you're using TypeScript, importing this library as a side effect will
automatically merge the log4js interface `Appenders`. This merging enables
autocomplete for the appenders configuration, providing convenient access to its
properties.

```ts
import "log4js-appender-cloudwatch";
```

### Example

```ts
import log4js from "log4js";

import "log4js-appender-cloudwatch";

log4js.configure({
	appenders: {
		cloudwatch: {
			type: "log4js-appender-cloudwatch",
			accessKeyId: "<secret>",
			secretAccessKey: "<secret>",
			region: "<config>",
			logGroupName: "<config>",
			logStreamName: "<config>",
			batchSize: 10,
			bufferTimeout: 1000, // in ms
		},
	},
	categories: {
		default: {
			level: "debug",
			appenders: [
				"cloudwatch",
			],
		},
	},
});

const log = log4js.getLogger();
// ...
```

## Options

### type

_Required_\
Type: `log4js-appender-cloudwatch`

Type of appender that's loaded from `node_modules`.

### batchSize

_Required_\
Type: `number`

Maximum number of log events to include in a single batch when sending. Once the
batch size is reached, it will be sent to CloudWatch.

### bufferTimeout

_Required_\
Type: `number`

Maximum time (in milliseconds) to wait before sending a batch of logs,
regardless of the batch size. If the timeout is reached before the batch size is
met, the logs will be sent.

### logGroupName (aws)

_Required_\
Type: `string`

The name of the log group in AWS CloudWatch Logs where your logs are stored.

### logStreamName (aws)

_Required_\
Type: `string`

The name of the log stream within the specified log group where your logs are
stored.

### region (aws)

_Required_\
Type: `string`

The AWS region where your log group and log stream are located.

### accessKeyId (aws)

_Required_\
Type: `string`

Your AWS access key ID for authentication.

### secretAccessKey (aws)

_Required_\
Type: `string`

Your AWS secret access key for authentication.

## Testing

To test this library during development, you'll need to provide your AWS
credentials. These credentials should be stored securely in a `.env` file
located at the root of your project directory.

```sh
# .env
ACCESSKEY_ID="<key>"
SECRET_ACCESS_KEY="<key>"
```

Then, you're ready to run tests:

```sh
npm test
```
