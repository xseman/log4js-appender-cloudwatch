import {
	CloudWatchLogs,
	CreateLogStreamRequest,
	InputLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import { layout as jsonLayout } from "log4js-layout-json";

import type {
	RegionInputConfig,
} from "@smithy/config-resolver/dist-types/regionConfig/resolveRegionConfig";
import type {
	AwsCredentialIdentity,
} from "@smithy/types/dist-types/identity/awsCredentialIdentity";
import type log4js from "log4js";

export interface Config
	extends
		CreateLogStreamRequest,
		Pick<RegionInputConfig, "region">,
		Pick<AwsCredentialIdentity, "accessKeyId" | "secretAccessKey" | "sessionToken">
{
	/**
	 * defaults to http://npm.im/log4js-layout-json
	 */
	layout?: log4js.Layout;
	/**
	 * Maximum number of log events to include in a single batch when sending.
	 * Once the batch size is reached, it will be sent to CloudWatch.
	 */
	batchSize: number;
	/**
	 * Maximum time (in milliseconds) to wait before sending a batch of logs,
	 * regardless of the batch size. If the timeout is reached before the batch
	 * size is met, the logs will be sent.
	 */
	bufferTimeout: number;
	/**
	 * required policy:
	 * - logs:CreateLogGroup
	 * - logs:CreateLogStream
	 */
	createResources?: boolean;
}

declare module "log4js" {
	interface Appenders {
		CloudwatchAppender: {
			type: "log4js-appender-cloudwatch";
		} & Config;
	}
}

class LogBuffer {
	private _timer: NodeJS.Timeout | null;
	private _logs: Array<InputLogEvent>;

	constructor(
		private config: Config,
		private _onReleaseCallback: (logs: Array<InputLogEvent>) => void,
	) {
		this._timer = null;
		this._logs = new Array();
	}

	/**
	 * Pushes a log message to the internal log buffer.
	 *
	 * @param message - The log message to be pushed. If it's an
	 *     object, it will be converted to a JSON string.
	 *
	 * @param - The timestamp of the log
	 *     message. If not provided, the current timestamp will be used.
	 */
	public push(message: string, timestamp?: number): void {
		if (typeof message === "object") {
			message = JSON.stringify(message);
		}
		if (timestamp === undefined) {
			timestamp = Date.now();
		}
		this._logs.push({
			message: message,
			timestamp: timestamp,
		});

		if (this._logs.length >= this.config.batchSize) {
			this.release();
			return;
		}

		if (this._timer === null) {
			this._timer = globalThis.setTimeout(() => {
				this.release();
			}, this.config.bufferTimeout);
			return;
		}
	}

	/**
	 * Releases the logs and clears the timer.
	 */
	public release(): void {
		if (this._timer) {
			globalThis.clearTimeout(this._timer);
			this._timer = null;
		}
		this._onReleaseCallback([...this._logs]);
		this._logs = [];
	}
}

/**
 * TODO: create async method for appender creation
 * 		 (for now log4js doesn't support async configure module)
 */
export function cloudwatch(
	config: Config,
	layout: log4js.LayoutFunction,
): log4js.AppenderFunction {
	const cloudwatch = new CloudWatchLogs({
		region: config.region,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			sessionToken: config.sessionToken
		},
	});

	if (config.createResources) {
		cloudwatch.createLogGroup({
			logGroupName: config.logGroupName,
		}).catch((error) => {
			if (error.name === "ResourceAlreadyExistsException") {
				// TODO: continue or exit
			}
		});

		cloudwatch.createLogStream({
			logGroupName: config.logGroupName,
			logStreamName: config.logStreamName,
		}).catch((error) => {
			if (error.name === "ResourceAlreadyExistsException") {
				// TODO: continue or exit
			}
		});
	} else {
		cloudwatch.describeLogGroups({
			logGroupNamePrefix: config.logGroupName,
		}).then((group) => {
			if (group.logGroups?.length === 0) {
				throw new ConfigError("Log group doesn't exists");
			}
		});

		cloudwatch.describeLogStreams({
			logGroupName: config.logGroupName,
			logStreamNamePrefix: config.logStreamName,
		}).then((streams) => {
			if (streams.logStreams?.length) {
				const stream = streams
					.logStreams
					.find((s) => s.logStreamName === config.logStreamName);

				if (stream === undefined) {
					throw new ConfigError("Stream name doesn't exists");
				}
			}
		});
	}

	/**
	 * TODO: integrate limitation to LogBuffer
	 *
	 * constraints:
	 * - The maximum batch size is 1,048,576 bytes. This size is calculated as the sum of all event messages in UTF-8, plus 26 bytes for each log event.
	 * - None of the log events in the batch can be more than 2 hours in the future.
	 * - None of the log events in the batch can be more than 14 days in the past. Also, none of the log events can be from earlier than the retention period of the log group.
	 * - The log events in the batch must be in chronological order by their timestamp. The timestamp is the time that the event occurred, expressed as the number of milliseconds after Jan 1, 1970 00:00:00 UTC. (In Amazon Web Services Tools for PowerShell and the Amazon Web Services SDK for .NET, the timestamp is specified in .NET format: yyyy-mm-ddThh:mm:ss. For example, 2017-09-15T13:45:30.)
	 * - Each log event can be no larger than 256 KB.
	 * - A batch of log events in a single request cannot span more than 24 hours. Otherwise, the operation fails.
	 * - The maximum number of log events in a batch is 10,000.
	 */
	const buffer = new LogBuffer(config, (logs): void => {
		cloudwatch.putLogEvents({
			logEvents: logs,
			logGroupName: config.logGroupName,
			logStreamName: config.logStreamName,
		});
	});

	return function appender(loggingEvent: log4js.LoggingEvent): void {
		const msg = layout(loggingEvent);
		const time = loggingEvent.startTime.getTime();

		buffer.push(msg, time);
	};
}

export class ConfigError extends Error {
	constructor(msg: string, cause?: unknown) {
		super(msg);
		this.cause = cause;
		this.name = this.constructor.name;
	}
}

export function configure(
	config: Config,
	layouts: log4js.LayoutsParam,
	_findAppender: () => log4js.AppenderFunction,
	_levels: log4js.Levels,
): log4js.AppenderFunction {
	let layout: log4js.LayoutFunction | undefined;

	if (config.layout) {
		// @ts-ignore: bad typings "config: PatternToken"
		layout = layouts.layout(config.layout.type, config.layout);
	} else {
		layout = jsonLayout();
	}

	const appender = cloudwatch(config, layout);
	return appender;
}
