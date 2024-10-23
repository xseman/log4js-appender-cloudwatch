import assert from "node:assert";
import process from "node:process";
import { before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { CloudWatchLogs } from "@aws-sdk/client-cloudwatch-logs";
import { layout as jsonLayout } from "log4js-layout-json";
import Level from "log4js/lib/levels";

import { cloudwatch, Config, ConfigError } from "./dist/index.js";

import type { LoggingEvent } from "log4js";

// NOTE: to run this test node v20.6+ is required for native .env loader
// nvm install && nvm use

function makeLogEvent(): LoggingEvent {
	return {
		categoryName: "default",
		startTime: new Date(),
		data: ["test"],
		pid: 0,
		fileName: "",
		lineNumber: 0,
		columnNumber: 0,
		callStack: "",
		functionName: "",
		context: { sub: "test" },
		serialise: () => "",
		level: new Level(20000, "INFO", "green"),
	};
}

const config = {
	batchSize: 10,
	bufferTimeout: 1_000,
	accessKeyId: process.env.ACCESSKEY_ID!,
	secretAccessKey: process.env.SECRET_ACCESS_KEY!,
	region: "eu-central-1",
	logGroupName: "prod",
	logStreamName: "bar",
	// createResources: true
} satisfies Config;

if (config.accessKeyId === undefined || config.secretAccessKey === undefined) {
	throw new ConfigError("");
}

describe("AWS Integration", () => {
	let cloudwatchClient: CloudWatchLogs;

	before(() => {
		cloudwatchClient = new CloudWatchLogs({
			region: config.region,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
		});
	});

	test("fill batch size", async () => {
		const layout = jsonLayout();
		const appender = cloudwatch(config, layout);
		const startTime = Date.now();

		// NOTE: batch is pushed after 10 events
		for (let i = 0; i < 10; i++) {
			const logEvent = makeLogEvent();
			appender(logEvent);
		}
		// NOTE: wait for 1 second to ensure all events are processed
		await sleep(1_000);

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
		const appender = cloudwatch(config, layout);
		const startTime = Date.now();

		// NOTE: batch is pushed after 10 events
		for (let i = 0; i < 5; i++) {
			const logEvent = makeLogEvent();
			appender(logEvent);
		}
		// NOTE: wait for 1.5 second for buffer timeout
		await sleep(1_500);

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
