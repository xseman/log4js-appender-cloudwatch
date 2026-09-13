import {
	describe,
	expect,
	test,
} from "bun:test";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
	CloudWatchLogs,
	type InputLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import log4js from "log4js";
import { levels } from "log4js";
import { layout as jsonLayout } from "log4js-layout-json";
// @ts-ignore: missing type definitions
import LoggingEvent from "log4js/lib/LoggingEvent.js";

import {
	CloudwatchAppender,
	type Config,
	createLogEventHandler,
	LogBuffer,
} from "./index.js";

describe("LogBuffer", () => {
	const logbufferConfig: Config = {
		batchSize: 5,
		bufferTimeout: 500,
		accessKeyId: "",
		secretAccessKey: "",
		logGroupName: "",
		logStreamName: "",
	};

	test("should release logs when batch size is reached", () => {
		const released: Array<InputLogEvent[]> = [];
		const logbuffer = new LogBuffer(logbufferConfig, (logs) => released.push(logs));

		for (let i = 0; i < 5; i++) {
			logbuffer.push(`log message ${i}`);
		}

		expect(released).toHaveLength(1);
		expect(released[0]).toHaveLength(5);
	});

	test("should release logs when buffer timeout is reached", async () => {
		const released: Array<InputLogEvent[]> = [];
		const logbuffer = new LogBuffer(logbufferConfig, (logs) => released.push(logs));

		for (let i = 0; i < 3; i++) {
			logbuffer.push(`log message ${i}`);
		}
		expect(released).toHaveLength(0);

		// Wait for buffer timeout
		await sleep(600);

		expect(released).toHaveLength(1);
		expect(released[0]).toHaveLength(3);
	});
});

function makeLogEvent(): log4js.LoggingEvent {
	return new LoggingEvent("default", levels.INFO, ["test"], { sub: "test" });
}

const hasCredentials = Boolean(process.env.ACCESSKEY_ID && process.env.SECRET_ACCESS_KEY);

describe.skipIf(!hasCredentials)("AWS Integration", () => {
	const config: Config = {
		batchSize: 10,
		bufferTimeout: 1_000,
		accessKeyId: process.env.ACCESSKEY_ID!,
		secretAccessKey: process.env.SECRET_ACCESS_KEY!,
		region: "eu-central-1",
		logGroupName: "prod",
		logStreamName: "bar",
		// createResources: true
	};

	const cloudwatchClient = new CloudWatchLogs({
		region: config.region,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
	});

	const logbuffer = new LogBuffer(
		config,
		createLogEventHandler(cloudwatchClient, config),
	);

	test("fill batch size", async () => {
		const layout = jsonLayout();
		const appender = new CloudwatchAppender(
			config,
			layout,
			logbuffer,
			cloudwatchClient,
		);
		const append = appender.appenderFunction();

		const startTime = Date.now();

		// NOTE: batch is pushed after 10 events
		for (let i = 0; i < 10; i++) {
			append(makeLogEvent());
		}
		// NOTE: wait for 2s to ensure all events are processed
		await sleep(2_000);

		// NOTE: fetch log events, if events are not appearing, increase sleep duration
		const data = await cloudwatchClient.getLogEvents({
			startTime: startTime,
			logStreamName: config.logStreamName,
			logGroupName: config.logGroupName,
		});
		expect(data.events).toHaveLength(10);

		for (const e of data.events!) {
			expect(JSON.parse(e.message!)).toMatchObject({
				category: "default",
				level: "INFO",
				msg: "test",
			});
		}
	}, 15_000);

	test("wait for buffer timeout", async () => {
		const layout = jsonLayout();
		const appender = new CloudwatchAppender(
			config,
			layout,
			logbuffer,
			cloudwatchClient,
		);
		const startTime = Date.now();
		const append = appender.appenderFunction();

		// NOTE: batch is pushed after 10 events
		for (let i = 0; i < 5; i++) {
			append(makeLogEvent());
		}

		// NOTE: wait for 2s for buffer timeout
		await sleep(2_000);

		// NOTE: fetch log events, if events are not appearing, increase sleep duration
		const data = await cloudwatchClient.getLogEvents({
			startTime: startTime,
			logStreamName: config.logStreamName,
			logGroupName: config.logGroupName,
		});
		expect(data.events).toHaveLength(5);

		for (const e of data.events!) {
			expect(JSON.parse(e.message!)).toMatchObject({
				category: "default",
				level: "INFO",
				msg: "test",
				sub: "test", // from context
			});
		}
	}, 15_000);
});
