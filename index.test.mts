import assert from "node:assert";
import process from "node:process";
import {
	describe,
	test,
} from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
	CloudWatchLogs,
	type InputLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import { layout as jsonLayout } from "log4js-layout-json";

import Level from "log4js/lib/levels.js";
import LoggingEvent from "log4js/lib/LoggingEvent.js";

import {
	CloudwatchAppender,
	Config,
	createLogEventHandler,
	LogBuffer,
} from "./dist/index.js";

describe("LogBuffer", () => {
	const logbufferConfig: Config = {
		batchSize: 5,
		bufferTimeout: 500,
		accessKeyId: process.env.ACCESSKEY_ID!,
		secretAccessKey: process.env.SECRET_ACCESS_KEY!,
		logGroupName: "",
		logStreamName: "",
	};

	test("should release logs when batch size is reached", () => {
		const mockCallback = (logs: Array<InputLogEvent>) => {
			assert.equal(logs.length, 5);
		};

		const logbuffer = new LogBuffer(logbufferConfig, mockCallback);

		for (let i = 0; i < 5; i++) {
			logbuffer.push(`log message ${i}`);
		}
	});

	test("should release logs when buffer timeout is reached", async () => {
		const mockCallback = (logs: Array<InputLogEvent>) => {
			assert.equal(logs.length, 3);
		};

		const logbuffer = new LogBuffer(logbufferConfig, mockCallback);

		for (let i = 0; i < 3; i++) {
			logbuffer.push(`log message ${i}`);
		}

		// Wait for buffer timeout
		await sleep(600);
	});
});

function makeLogEvent() {
	return new LoggingEvent(
		"default",
		new Level(20000, "INFO", "green"),
		["test"],
		{ sub: "test" },
		undefined,
	);
}

describe("AWS Integration", () => {
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
			const logEvent = makeLogEvent();
			append(logEvent);
		}
		// NOTE: wait for 2s to ensure all events are processed
		await sleep(2_000);

		// NOTE: fetch log events, if events are not appearing, increase sleep duration
		const data = await cloudwatchClient.getLogEvents({
			startTime: startTime,
			logStreamName: config.logStreamName,
			logGroupName: config.logGroupName,
		});
		assert.equal(data.events?.length, 10);

		for (const e of data.events!) {
			const data = JSON.parse(e.message!);
			assert.equal(data.category, "default");
			assert.equal(data.level, "INFO");
			assert.equal(data.msg, "test");
		}
	});

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
			const logEvent = makeLogEvent();
			append(logEvent);
		}

		// NOTE: wait for 2s for buffer timeout
		await sleep(2_000);

		// NOTE: fetch log events, if events are not appearing, increase sleep duration
		const data = await cloudwatchClient.getLogEvents({
			startTime: startTime,
			logStreamName: config.logStreamName,
			logGroupName: config.logGroupName,
		});
		assert.equal(data.events?.length, 5);

		for (const e of data.events!) {
			const data = JSON.parse(e.message!);
			assert.equal(data.category, "default");
			assert.equal(data.level, "INFO");
			assert.equal(data.msg, "test");
			assert.equal(data.sub, "test"); // from context
		}
	});
});
