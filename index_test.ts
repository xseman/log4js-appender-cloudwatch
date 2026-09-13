import {
	afterEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
	CloudWatchLogs,
	type InputLogEvent,
	type PutLogEventsRequest,
	ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import log4js from "log4js";
import { levels } from "log4js";
import { layout as jsonLayout } from "log4js-layout-json";
// @ts-ignore: missing type definitions
import layouts from "log4js/lib/layouts.js";
// @ts-ignore: missing type definitions
import LoggingEvent from "log4js/lib/LoggingEvent.js";

import {
	CloudwatchAppender,
	type Config,
	ConfigError,
	configure,
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

const mockConfig: Config = {
	batchSize: 1,
	bufferTimeout: 1_000,
	accessKeyId: "id",
	secretAccessKey: "secret",
	region: "eu-central-1",
	logGroupName: "group",
	logStreamName: "stream",
};

function makeClient(overrides: Record<string, (input: any) => Promise<unknown>> = {}) {
	const client = {
		createLogGroup: mock(async (_input: any): Promise<unknown> => ({})),
		createLogStream: mock(async (_input: any): Promise<unknown> => ({})),
		describeLogGroups: mock(async (_input: any): Promise<unknown> => ({
			logGroups: [{ logGroupName: "group" }],
		})),
		describeLogStreams: mock(async (_input: any): Promise<unknown> => ({
			logStreams: [{ logStreamName: "stream" }],
		})),
		putLogEvents: mock(async (_input: any): Promise<unknown> => ({})),
	};
	Object.assign(client, overrides);

	return client;
}

describe("CloudwatchAppender", () => {
	const noopBuffer = new LogBuffer(mockConfig, () => {});

	test("verifies log group and stream on start", async () => {
		const client = makeClient();
		new CloudwatchAppender(mockConfig, jsonLayout(), noopBuffer, client as any);
		await sleep(0);

		expect(client.describeLogGroups).toHaveBeenCalledWith({ logGroupNamePrefix: "group" });
		expect(client.describeLogStreams).toHaveBeenCalledWith({
			logGroupName: "group",
			logStreamNamePrefix: "stream",
		});
		expect(client.createLogGroup).not.toHaveBeenCalled();
	});

	test("creates log stream even when the log group already exists", async () => {
		const client = makeClient({
			createLogGroup: async () => {
				throw new ResourceAlreadyExistsException({ message: "exists", $metadata: {} });
			},
		});
		const config: Config = { ...mockConfig, createResources: true };

		new CloudwatchAppender(config, jsonLayout(), noopBuffer, client as any);
		await sleep(10);

		expect(client.createLogStream).toHaveBeenCalledWith({
			logGroupName: "group",
			logStreamName: "stream",
		});
		expect(client.describeLogGroups).not.toHaveBeenCalled();
	});

	test("formats and buffers logging events", async () => {
		const released: Array<InputLogEvent[]> = [];
		const buffer = new LogBuffer(mockConfig, (logs) => released.push(logs));
		const appender = new CloudwatchAppender(
			mockConfig,
			jsonLayout(),
			buffer,
			makeClient() as any,
		);
		const event = makeLogEvent();

		appender.appenderFunction()(event);

		expect(released).toHaveLength(1);
		expect(released[0][0].timestamp).toBe(event.startTime.getTime());
		expect(JSON.parse(released[0][0].message!)).toMatchObject({
			category: "default",
			level: "INFO",
			msg: "test",
		});
	});
});

describe("createLogEventHandler", () => {
	test("sends the batch to the configured log group and stream", () => {
		const client = makeClient();
		const logEvents: InputLogEvent[] = [{ message: "a", timestamp: 1 }];

		createLogEventHandler(client as any, mockConfig)(logEvents);

		expect(client.putLogEvents).toHaveBeenCalledWith({
			logEvents: logEvents,
			logGroupName: "group",
			logStreamName: "stream",
		});
	});
});

describe("ConfigError", () => {
	test("keeps name, message and cause", () => {
		const cause = new Error("root");
		const error = new ConfigError("invalid config", cause);

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("ConfigError");
		expect(error.message).toBe("invalid config");
		expect(error.cause).toBe(cause);
	});
});

describe("configure", () => {
	afterEach(() => {
		mock.restore();
	});

	function mockClientPrototype() {
		const proto = CloudWatchLogs.prototype as any;
		const client = makeClient();
		spyOn(proto, "describeLogGroups").mockImplementation(client.describeLogGroups);
		spyOn(proto, "describeLogStreams").mockImplementation(client.describeLogStreams);
		spyOn(proto, "putLogEvents").mockImplementation(client.putLogEvents);

		return client;
	}

	function sentMessages(client: ReturnType<typeof makeClient>): string[] {
		return client.putLogEvents.mock.calls.flatMap(([input]) =>
			(input as PutLogEventsRequest).logEvents!.map((e) => e.message!)
		);
	}

	test("returns an appender that sends json formatted events", () => {
		const client = mockClientPrototype();
		const appender = configure(mockConfig, layouts, () => () => {}, levels);

		appender(makeLogEvent());

		const messages = sentMessages(client);
		expect(messages).toHaveLength(1);
		expect(JSON.parse(messages[0])).toMatchObject({
			category: "default",
			level: "INFO",
			msg: "test",
			sub: "test",
		});
	});

	test("uses the configured log4js layout", () => {
		const client = mockClientPrototype();
		const config: Config = {
			...mockConfig,
			layout: { type: "pattern", pattern: "%c %m" },
		};
		const appender = configure(config, layouts, () => () => {}, levels);

		appender(makeLogEvent());

		expect(sentMessages(client)).toEqual(["default test"]);
	});
});

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
