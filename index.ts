import {
	CloudWatchLogs,
	type CreateLogStreamRequest,
	type InputLogEvent,
	ResourceAlreadyExistsException,
	ResourceNotFoundException,
	UnrecognizedClientException,
} from "@aws-sdk/client-cloudwatch-logs";
import { layout as jsonLayout } from "log4js-layout-json";

import type {
	RegionInputConfig,
} from "@smithy/config-resolver/dist-types/regionConfig/resolveRegionConfig";
import type {
	AwsCredentialIdentity,
} from "@smithy/types/dist-types/identity/awsCredentialIdentity";
import type log4js from "log4js";

export interface Config extends
	CreateLogStreamRequest,
	Pick<RegionInputConfig, "region">,
	Pick<
		AwsCredentialIdentity,
		"accessKeyId" | "secretAccessKey" | "sessionToken"
	>
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

export class LogBuffer {
	private _timer: NodeJS.Timeout | null;
	private _logs: Array<InputLogEvent>;

	constructor(
		private _config: Config,
		private _onReleaseCallback: (logs: Array<InputLogEvent>) => void,
	) {
		this._timer = null;
		this._logs = [];
	}

	/**
	 * Pushes a log message to the internal log buffer.
	 *
	 * @param message - The log message to be pushed. If it's an
	 *     object, it will be converted to a JSON string.
	 * f
	 * @param timestamp - The timestamp of the log
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

		if (this._logs.length >= this._config.batchSize) {
			this.release();
			return;
		}

		if (this._timer === null) {
			this._timer = globalThis.setTimeout(() => {
				this.release();
			}, this._config.bufferTimeout);
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

export class CloudwatchAppender {
	constructor(
		private _config: Config,
		private _layout: log4js.LayoutFunction,
		private _logEventBuffer: LogBuffer,
		private _cloudwatchClient: CloudWatchLogs,
	) {
		if (this._config.createResources) {
			this.createLogGroups();
		} else {
			this.initializeLogGroups();
		}
	}

	/**
	 * Creates log groups and streams in CloudWatch if they don't exist.
	 * If resources already exist, the creation requests are silently ignored.
	 */
	private createLogGroups(): void {
		this._cloudwatchClient
			.createLogGroup({
				logGroupName: this._config.logGroupName,
			})
			.catch((error) => {
				if (error instanceof ResourceAlreadyExistsException) {
					// NOTE: continue, nothing to do
				}
			})
			.finally(() => {
				this._cloudwatchClient
					.createLogStream({
						logGroupName: this._config.logGroupName,
						logStreamName: this._config.logStreamName,
					})
					.catch((error) => {
						if (error instanceof ResourceAlreadyExistsException) {
							// NOTE: continue, nothing to do
						}
					});
			});
	}

	/**
	 * Verifies that the configured log groups and streams exist in CloudWatch.
	 *
	 * @throws {ConfigError} If log group/stream doesn't exist or credentials are invalid
	 */
	private initializeLogGroups(): void {
		this._cloudwatchClient
			.describeLogGroups({
				logGroupNamePrefix: this._config.logGroupName,
			})
			.then((group) => {
				if (group.logGroups?.length === 0) {
					throw new ConfigError("Log group doesn't exist");
				}
			})
			.catch((error) => {
				if (error instanceof ResourceNotFoundException) {
					// TODO: handle error
				}
			});

		this._cloudwatchClient
			.describeLogStreams({
				logGroupName: this._config.logGroupName,
				logStreamNamePrefix: this._config.logStreamName,
			})
			.then((streams) => {
				if (streams.logStreams?.length) {
					const streamExists = streams
						.logStreams
						.find((s) => s.logStreamName === this._config.logStreamName);

					if (!streamExists) {
						throw new ConfigError("Stream name doesn't exist");
					}
				}
			})
			.catch((error) => {
				if (error instanceof UnrecognizedClientException) {
					throw new ConfigError("Invalid credentials");
				}

				if (error instanceof ResourceNotFoundException) {
					// TODO: handle error
				}

				throw error;
			});
	}

	/**
	 * Returns the appender function that will be used by log4js.
	 *
	 * The function processes logging events by formatting them using the configured layout
	 * and buffering them for batch processing.
	 *
	 * @returns {log4js.AppenderFunction} The function that will handle logging events
	 */
	public appenderFunction(): log4js.AppenderFunction {
		return (loggingEvent: log4js.LoggingEvent): void => {
			const message = this._layout(loggingEvent);
			const time = loggingEvent.startTime.getTime();

			this._logEventBuffer.push(message, time);
		};
	}
}

export class ConfigError extends Error {
	constructor(msg: string, cause?: unknown) {
		super(msg);
		this.cause = cause;
		this.name = this.constructor.name;
	}
}

export function createLogEventHandler(
	cloudwatchClient: CloudWatchLogs,
	config: Config,
): LogBuffer["_onReleaseCallback"] {
	return function handleLogRelease(logEventBatch: InputLogEvent[]): void {
		cloudwatchClient.putLogEvents({
			logEvents: logEventBatch,
			logGroupName: config.logGroupName,
			logStreamName: config.logStreamName,
		});
	};
}

export function configure(
	config: Config,
	layouts: log4js.LayoutsParam,
	_findAppender: () => log4js.AppenderFunction,
	_levels: log4js.Levels,
): log4js.AppenderFunction {
	const cloudwatchClient = new CloudWatchLogs({
		region: config.region,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			sessionToken: config.sessionToken,
		},
	});

	const buffer = new LogBuffer(
		config,
		createLogEventHandler(cloudwatchClient, config),
	);

	let layout: log4js.LayoutFunction | undefined;
	if (config.layout) {
		// @ts-ignore: bad typings "config: PatternToken"
		layout = layouts.layout(config.layout.type, config.layout);
	} else {
		layout = jsonLayout();
	}

	const appender = new CloudwatchAppender(
		config,
		layout,
		buffer,
		cloudwatchClient,
	);

	return appender.appenderFunction;
}
