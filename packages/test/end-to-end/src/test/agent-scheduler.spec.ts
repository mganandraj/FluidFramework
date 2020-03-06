/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

/* eslint-disable unicorn/filename-case */

import * as assert from "assert";
import { AgentSchedulerFactory, TaskManager } from "@microsoft/fluid-agent-scheduler";
import { TestHost } from "@microsoft/fluid-local-test-utils";
import { IAgentScheduler } from "@microsoft/fluid-runtime-definitions";
import { DocumentDeltaEventManager } from "@microsoft/fluid-local-driver";

const AgentSchedulerType = "@microsoft/fluid-agent-scheduler";

describe("AgentScheduler", () => {
    const leader = "leader";

    describe("Single client", () => {
        let host: TestHost;
        let scheduler: IAgentScheduler;

        beforeEach(async () => {
            host = new TestHost([
                [AgentSchedulerType, Promise.resolve(new AgentSchedulerFactory())],
            ]);

            scheduler = await host.getComponent<TaskManager>(AgentSchedulerFactory.type)
                .then((taskmanager) => taskmanager.IAgentScheduler);

            // Make sure all initial ops (around leadership) are processed.
            // It takes a while because we start in unattached mode, and attach scheduler,
            // which causes loss of all tasks and reassignment
            const docScheduler = new DocumentDeltaEventManager(host.deltaConnectionServer);
            const doc = await host.getDocumentDeltaEvent();
            docScheduler.registerDocuments(doc);
            await docScheduler.process(doc);
            await docScheduler.resumeProcessing(doc);
        });

        afterEach(async () => { await host.close(); });

        it("No tasks initially", async () => {
            assert.deepStrictEqual(scheduler.pickedTasks(), [leader]);
        });

        it("Can pick tasks", async () => {
            await scheduler.pick("task1", async () => {});
            assert.deepStrictEqual(scheduler.pickedTasks() , [leader, "task1"]);
        });

        it("Can pick and release tasks", async () => {
            await scheduler.pick("task1", async () => {});
            assert.deepStrictEqual(scheduler.pickedTasks() , [leader, "task1"]);
            await scheduler.release("task1");
            assert.deepStrictEqual(scheduler.pickedTasks(), [leader]);
        });

        it("Can register task without picking up", async () => {
            await scheduler.register("task1");
            assert.deepStrictEqual(scheduler.pickedTasks() , [leader]);
        });

        it("Duplicate picking fails", async () => {
            await scheduler.pick("task1", async () => {});
            assert.deepStrictEqual(scheduler.pickedTasks() , [leader, "task1"]);
            await scheduler.pick("task1", async () => {}).catch((err) => {
                assert.deepStrictEqual(err, "task1 is already attempted");
            });
        });

        it("Unpicked task release should fail", async () => {
            await scheduler.pick("task1", async () => {});
            await scheduler.release("task2").catch((err) => {
                assert.deepStrictEqual(err, "task2 was never registered");
            });
        });

        it("Should pick previously released task", async () => {
            await scheduler.pick("task1", async () => {});
            assert.deepStrictEqual(scheduler.pickedTasks() , [leader, "task1"]);
            await scheduler.release("task1");
            assert.deepStrictEqual(scheduler.pickedTasks(), [leader]);
            await scheduler.pick("task1", async () => {});
            assert.deepStrictEqual(scheduler.pickedTasks() , [leader, "task1"]);
        });

        it("Single client must be the leader", async () => {
            assert.deepStrictEqual(scheduler.pickedTasks() , [leader]);
            await scheduler.pick("task1", async () => {});
            await scheduler.release("task1");
            assert.deepStrictEqual(scheduler.pickedTasks() , [leader]);
        });
    });

    describe("Multiple clients", () => {
        let host1: TestHost;
        let host2: TestHost;
        let scheduler1: IAgentScheduler;
        let scheduler2: IAgentScheduler;

        beforeEach(async () => {
            host1 = new TestHost([
                [AgentSchedulerType, Promise.resolve(new AgentSchedulerFactory())],
            ]);
            host2 = host1.clone();
            scheduler1 = await host1.getComponent<TaskManager>("_scheduler")
                .then((taskmanager) => taskmanager.IAgentScheduler);
            scheduler2 = await host2.getComponent<TaskManager>("_scheduler")
                .then((taskmanager) => taskmanager.IAgentScheduler);

            // Make sure all initial ops (around leadership) are processed.
            // It takes a while because we start in unattached mode, and attach scheduler,
            // which causes loss of all tasks and reassignment
            const docScheduler = new DocumentDeltaEventManager(host1.deltaConnectionServer);
            const doc1 = await host1.getDocumentDeltaEvent();
            const doc2 = await host2.getDocumentDeltaEvent();
            docScheduler.registerDocuments(doc1, doc2);
            await docScheduler.process(doc1, doc2);
            await docScheduler.resumeProcessing(doc1, doc2);
        });

        afterEach(async () => {
            await TestHost.sync(host1, host2);
            await host1.close();
            await host2.close();
        });

        it("No tasks initially", async () => {
            assert.deepStrictEqual(scheduler1.pickedTasks(), [leader]);
            assert.deepStrictEqual(scheduler2.pickedTasks(), []);
        });

        it("Clients agree on picking tasks sequentially", async () => {
            await scheduler1.pick("task1", async () => {});
            await TestHost.sync(host1, host2);
            assert.deepStrictEqual(scheduler1.pickedTasks(), [leader, "task1"]);
            assert.deepStrictEqual(scheduler2.pickedTasks(), []);
            await scheduler2.pick("task2", async () => {});
            await TestHost.sync(host1, host2);
            assert.deepStrictEqual(scheduler1.pickedTasks(), [leader, "task1"]);
            assert.deepStrictEqual(scheduler2.pickedTasks(), ["task2"]);
        });

        it("Picking same tasks are exclusive and agreed upon", async () => {
            await scheduler1.pick("task1", async () => {});
            await scheduler1.pick("task2", async () => {});
            await scheduler1.pick("task3", async () => {});
            await scheduler2.pick("task2", async () => {});
            await scheduler2.pick("task3", async () => {});
            await scheduler2.pick("task4", async () => {});
            await TestHost.sync(host1, host2);
            assert.deepStrictEqual(scheduler1.pickedTasks(), [leader, "task1", "task2", "task3"]);
            assert.deepStrictEqual(scheduler2.pickedTasks(), ["task4"]);
        });

        it("Concurrent task picking outcome should be deterministic", async () => {
            await scheduler1.pick("task1", async () => {});
            await scheduler1.pick("task2", async () => {});
            await scheduler2.pick("task2", async () => {});
            await scheduler2.pick("task1", async () => {});
            await scheduler2.pick("task4", async () => {});
            await scheduler1.pick("task4", async () => {});
            await scheduler1.pick("task5", async () => {});
            await scheduler2.pick("task5", async () => {});
            await scheduler2.pick("task6", async () => {});
            await TestHost.sync(host1, host2);
            assert.deepStrictEqual(scheduler1.pickedTasks(), [leader, "task1", "task2", "task5"]);
            assert.deepStrictEqual(scheduler2.pickedTasks(), ["task4", "task6"]);
        });

        it("Tasks not currently hold can not be released", async () => {
            await scheduler1.pick("task1", async () => {});
            await scheduler1.pick("task2", async () => {});
            await scheduler2.pick("task2", async () => {});
            await scheduler2.pick("task1", async () => {});
            await scheduler2.pick("task4", async () => {});
            await scheduler1.pick("task4", async () => {});
            await scheduler1.pick("task5", async () => {});
            await scheduler2.pick("task5", async () => {});
            await scheduler2.pick("task6", async () => {});
            await TestHost.sync(host1, host2);
            await scheduler1.release("task4").catch((err) => {
                assert.deepStrictEqual(err, "task4 was never picked");
            });
            await scheduler2.release("task1").catch((err) => {
                assert.deepStrictEqual(err, "task1 was never picked");
            });
            await scheduler2.release("task2").catch((err) => {
                assert.deepStrictEqual(err, "task2 was never picked");
            });
        });

        it("Released tasks are automatically picked up by interested clients", async () => {
            await scheduler1.pick("task1", async () => {});
            await scheduler1.pick("task2", async () => {});
            await scheduler2.pick("task2", async () => {});
            await scheduler2.pick("task1", async () => {});
            await scheduler2.pick("task4", async () => {});
            await scheduler1.pick("task4", async () => {});
            await scheduler1.pick("task5", async () => {});
            await scheduler2.pick("task5", async () => {});
            await scheduler2.pick("task6", async () => {});
            await TestHost.sync(host1, host2);
            assert.deepStrictEqual(scheduler1.pickedTasks(), [leader, "task1", "task2", "task5"]);
            assert.deepStrictEqual(scheduler2.pickedTasks(), ["task4", "task6"]);
            await scheduler1.release("task2", "task1", "task5");
            await TestHost.sync(host1, host2);
            assert.deepStrictEqual(scheduler1.pickedTasks(), [leader]);
            await TestHost.sync(host2);
            assert.deepStrictEqual(scheduler2.pickedTasks().sort(), ["task1", "task2", "task4", "task5", "task6"]);
            await scheduler1.pick("task1", async () => {});
            await scheduler1.pick("task2", async () => {});
            await scheduler1.pick("task5", async () => {});
            await scheduler1.pick("task6", async () => {});
            await scheduler2.release("task2", "task1", "task4", "task5", "task6");
            await TestHost.sync(host1, host2);
            assert.deepStrictEqual(scheduler1.pickedTasks().sort(),
                [leader, "task1", "task2", "task4", "task5", "task6"]);
        });

        it("Releasing leadership should automatically elect a new leader", async () => {
            await scheduler1.release(leader);
            await TestHost.sync(host1, host2);
            assert.deepStrictEqual(scheduler1.pickedTasks(), []);
            assert.deepStrictEqual(scheduler2.pickedTasks(), [leader]);
        });
    });
});
