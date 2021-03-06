/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import PlatformPeg from "../PlatformPeg";
import {MatrixClientPeg} from "../MatrixClientPeg";
import {EventTimeline, RoomMember} from 'matrix-js-sdk';

/*
 * Event indexing class that wraps the platform specific event indexing.
 */
export default class EventIndex {
    constructor() {
        this.crawlerCheckpoints = [];
        // The time that the crawler will wait between /rooms/{room_id}/messages
        // requests
        this._crawlerTimeout = 3000;
        // The maximum number of events our crawler should fetch in a single
        // crawl.
        this._eventsPerCrawl = 100;
        this._crawler = null;
        this.liveEventsForIndex = new Set();
    }

    async init() {
        const indexManager = PlatformPeg.get().getEventIndexingManager();

        await indexManager.initEventIndex();
        console.log("EventIndex: Successfully initialized the event index");

        this.crawlerCheckpoints = await indexManager.loadCheckpoints();
        console.log("EventIndex: Loaded checkpoints", this.crawlerCheckpoints);

        this.registerListeners();
    }

    registerListeners() {
        const client = MatrixClientPeg.get();

        client.on('sync', this.onSync);
        client.on('Room.timeline', this.onRoomTimeline);
        client.on('Event.decrypted', this.onEventDecrypted);
        client.on('Room.timelineReset', this.onTimelineReset);
    }

    removeListeners() {
        const client = MatrixClientPeg.get();
        if (client === null) return;

        client.removeListener('sync', this.onSync);
        client.removeListener('Room.timeline', this.onRoomTimeline);
        client.removeListener('Event.decrypted', this.onEventDecrypted);
        client.removeListener('Room.timelineReset', this.onTimelineReset);
    }

    onSync = async (state, prevState, data) => {
        const indexManager = PlatformPeg.get().getEventIndexingManager();

        if (prevState === "PREPARED" && state === "SYNCING") {
            const addInitialCheckpoints = async () => {
                const client = MatrixClientPeg.get();
                const rooms = client.getRooms();

                const isRoomEncrypted = (room) => {
                    return client.isRoomEncrypted(room.roomId);
                };

                // We only care to crawl the encrypted rooms, non-encrypted.
                // rooms can use the search provided by the homeserver.
                const encryptedRooms = rooms.filter(isRoomEncrypted);

                console.log("EventIndex: Adding initial crawler checkpoints");

                // Gather the prev_batch tokens and create checkpoints for
                // our message crawler.
                await Promise.all(encryptedRooms.map(async (room) => {
                    const timeline = room.getLiveTimeline();
                    const token = timeline.getPaginationToken("b");

                    console.log("EventIndex: Got token for indexer",
                                room.roomId, token);

                    const backCheckpoint = {
                        roomId: room.roomId,
                        token: token,
                        direction: "b",
                    };

                    const forwardCheckpoint = {
                        roomId: room.roomId,
                        token: token,
                        direction: "f",
                    };

                    await indexManager.addCrawlerCheckpoint(backCheckpoint);
                    await indexManager.addCrawlerCheckpoint(forwardCheckpoint);
                    this.crawlerCheckpoints.push(backCheckpoint);
                    this.crawlerCheckpoints.push(forwardCheckpoint);
                }));
            };

            // If our indexer is empty we're most likely running Riot the
            // first time with indexing support or running it with an
            // initial sync. Add checkpoints to crawl our encrypted rooms.
            const eventIndexWasEmpty = await indexManager.isEventIndexEmpty();
            if (eventIndexWasEmpty) await addInitialCheckpoints();

            // Start our crawler.
            this.startCrawler();
            return;
        }

        if (prevState === "SYNCING" && state === "SYNCING") {
            // A sync was done, presumably we queued up some live events,
            // commit them now.
            console.log("EventIndex: Committing events");
            await indexManager.commitLiveEvents();
            return;
        }
    }

    onRoomTimeline = async (ev, room, toStartOfTimeline, removed, data) => {
        // We only index encrypted rooms locally.
        if (!MatrixClientPeg.get().isRoomEncrypted(room.roomId)) return;

        // If it isn't a live event or if it's redacted there's nothing to
        // do.
        if (toStartOfTimeline || !data || !data.liveEvent
            || ev.isRedacted()) {
            return;
        }

        // If the event is not yet decrypted mark it for the
        // Event.decrypted callback.
        if (ev.isBeingDecrypted()) {
            const eventId = ev.getId();
            this.liveEventsForIndex.add(eventId);
        } else {
            // If the event is decrypted or is unencrypted add it to the
            // index now.
            await this.addLiveEventToIndex(ev);
        }
    }

    onEventDecrypted = async (ev, err) => {
        const eventId = ev.getId();

        // If the event isn't in our live event set, ignore it.
        if (!this.liveEventsForIndex.delete(eventId)) return;
        if (err) return;
        await this.addLiveEventToIndex(ev);
    }

    async addLiveEventToIndex(ev) {
        const indexManager = PlatformPeg.get().getEventIndexingManager();

        if (["m.room.message", "m.room.name", "m.room.topic"]
            .indexOf(ev.getType()) == -1) {
            return;
        }

        const jsonEvent = ev.toJSON();
        const e = ev.isEncrypted() ? jsonEvent.decrypted : jsonEvent;

        const profile = {
            displayname: ev.sender.rawDisplayName,
            avatar_url: ev.sender.getMxcAvatarUrl(),
        };

        indexManager.addEventToIndex(e, profile);
    }

    async crawlerFunc() {
        // TODO either put this in a better place or find a library provided
        // method that does this.
        const sleep = async (ms) => {
            return new Promise(resolve => setTimeout(resolve, ms));
        };

        let cancelled = false;

        console.log("EventIndex: Started crawler function");

        const client = MatrixClientPeg.get();
        const indexManager = PlatformPeg.get().getEventIndexingManager();

        this._crawler = {};

        this._crawler.cancel = () => {
            cancelled = true;
        };

        while (!cancelled) {
            // This is a low priority task and we don't want to spam our
            // homeserver with /messages requests so we set a hefty timeout
            // here.
            await sleep(this._crawlerTimeout);

            console.log("EventIndex: Running the crawler loop.");

            if (cancelled) {
                break;
            }

            const checkpoint = this.crawlerCheckpoints.shift();

            /// There is no checkpoint available currently, one may appear if
            // a sync with limited room timelines happens, so go back to sleep.
            if (checkpoint === undefined) {
                continue;
            }

            console.log("EventIndex: crawling using checkpoint", checkpoint);

            // We have a checkpoint, let us fetch some messages, again, very
            // conservatively to not bother our homeserver too much.
            const eventMapper = client.getEventMapper();
            // TODO we need to ensure to use member lazy loading with this
            // request so we get the correct profiles.
            let res;

            try {
                res = await client._createMessagesRequest(
                    checkpoint.roomId, checkpoint.token, this._eventsPerCrawl,
                    checkpoint.direction);
            } catch (e) {
                console.log("EventIndex: Error crawling events:", e);
                this.crawlerCheckpoints.push(checkpoint);
                continue;
            }

            if (res.chunk.length === 0) {
                console.log("EventIndex: Done with the checkpoint", checkpoint);
                // We got to the start/end of our timeline, lets just
                // delete our checkpoint and go back to sleep.
                await indexManager.removeCrawlerCheckpoint(checkpoint);
                continue;
            }

            // Convert the plain JSON events into Matrix events so they get
            // decrypted if necessary.
            const matrixEvents = res.chunk.map(eventMapper);
            let stateEvents = [];
            if (res.state !== undefined) {
                stateEvents = res.state.map(eventMapper);
            }

            const profiles = {};

            stateEvents.forEach(ev => {
                if (ev.event.content &&
                    ev.event.content.membership === "join") {
                    profiles[ev.event.sender] = {
                        displayname: ev.event.content.displayname,
                        avatar_url: ev.event.content.avatar_url,
                    };
                }
            });

            const decryptionPromises = [];

            matrixEvents.forEach(ev => {
                if (ev.isBeingDecrypted() || ev.isDecryptionFailure()) {
                    // TODO the decryption promise is a private property, this
                    // should either be made public or we should convert the
                    // event that gets fired when decryption is done into a
                    // promise using the once event emitter method:
                    // https://nodejs.org/api/events.html#events_events_once_emitter_name
                    decryptionPromises.push(ev._decryptionPromise);
                }
            });

            // Let us wait for all the events to get decrypted.
            await Promise.all(decryptionPromises);

            // We filter out events for which decryption failed, are redacted
            // or aren't of a type that we know how to index.
            const isValidEvent = (value) => {
                return ([
                        "m.room.message",
                        "m.room.name",
                        "m.room.topic",
                    ].indexOf(value.getType()) >= 0
                        && !value.isRedacted() && !value.isDecryptionFailure()
                );
                // TODO do we need to check if the event has all the valid
                // attributes?
            };

            // TODO if there are no events at this point we're missing a lot
            // decryption keys, do we want to retry this checkpoint at a later
            // stage?
            const filteredEvents = matrixEvents.filter(isValidEvent);

            // Let us convert the events back into a format that EventIndex can
            // consume.
            const events = filteredEvents.map((ev) => {
                const jsonEvent = ev.toJSON();
                const e = ev.isEncrypted() ? jsonEvent.decrypted : jsonEvent;

                let profile = {};
                if (e.sender in profiles) profile = profiles[e.sender];
                const object = {
                    event: e,
                    profile: profile,
                };
                return object;
            });

            // Create a new checkpoint so we can continue crawling the room for
            // messages.
            const newCheckpoint = {
                roomId: checkpoint.roomId,
                token: res.end,
                fullCrawl: checkpoint.fullCrawl,
                direction: checkpoint.direction,
            };

            console.log(
                "EventIndex: Crawled room",
                client.getRoom(checkpoint.roomId).name,
                "and fetched", events.length, "events.",
            );

            try {
                const eventsAlreadyAdded = await indexManager.addHistoricEvents(
                    events, newCheckpoint, checkpoint);
                // If all events were already indexed we assume that we catched
                // up with our index and don't need to crawl the room further.
                // Let us delete the checkpoint in that case, otherwise push
                // the new checkpoint to be used by the crawler.
                if (eventsAlreadyAdded === true && newCheckpoint.fullCrawl !== true) {
                    console.log("EventIndex: Checkpoint had already all events",
                                "added, stopping the crawl", checkpoint);
                    await indexManager.removeCrawlerCheckpoint(newCheckpoint);
                } else {
                    this.crawlerCheckpoints.push(newCheckpoint);
                }
            } catch (e) {
                console.log("EventIndex: Error durring a crawl", e);
                // An error occurred, put the checkpoint back so we
                // can retry.
                this.crawlerCheckpoints.push(checkpoint);
            }
        }

        this._crawler = null;

        console.log("EventIndex: Stopping crawler function");
    }

    onTimelineReset = async (room, timelineSet, resetAllTimelines) => {
        if (room === null) return;

        const indexManager = PlatformPeg.get().getEventIndexingManager();
        if (!MatrixClientPeg.get().isRoomEncrypted(room.roomId)) return;

        const timeline = room.getLiveTimeline();
        const token = timeline.getPaginationToken("b");

        const backwardsCheckpoint = {
            roomId: room.roomId,
            token: token,
            fullCrawl: false,
            direction: "b",
        };

        console.log("EventIndex: Added checkpoint because of a limited timeline",
            backwardsCheckpoint);

        await indexManager.addCrawlerCheckpoint(backwardsCheckpoint);

        this.crawlerCheckpoints.push(backwardsCheckpoint);
    }

    startCrawler() {
        if (this._crawler !== null) return;
        this.crawlerFunc();
    }

    stopCrawler() {
        if (this._crawler === null) return;
        this._crawler.cancel();
    }

    async close() {
        const indexManager = PlatformPeg.get().getEventIndexingManager();
        this.removeListeners();
        this.stopCrawler();
        return indexManager.closeEventIndex();
    }

    async search(searchArgs) {
        const indexManager = PlatformPeg.get().getEventIndexingManager();
        return indexManager.searchEventIndex(searchArgs);
    }

    /**
     * Load events that contain URLs from the event index.
     *
     * @param {Room} room The room for which we should fetch events containing
     * URLs
     *
     * @param {number} limit The maximum number of events to fetch.
     *
     * @param {string} fromEvent From which event should we continue fetching
     * events from the index. This is only needed if we're continuing to fill
     * the timeline, e.g. if we're paginating. This needs to be set to a event
     * id of an event that was previously fetched with this function.
     *
     * @param {string} direction The direction in which we will continue
     * fetching events. EventTimeline.BACKWARDS to continue fetching events that
     * are older than the event given in fromEvent, EventTimeline.FORWARDS to
     * fetch newer events.
     *
     * @returns {Promise<MatrixEvent[]>} Resolves to an array of events that
     * contain URLs.
     */
    async loadFileEvents(room, limit = 10, fromEvent = null, direction = EventTimeline.BACKWARDS) {
        const client = MatrixClientPeg.get();
        const indexManager = PlatformPeg.get().getEventIndexingManager();

        const loadArgs = {
            roomId: room.roomId,
            limit: limit,
        };

        if (fromEvent) {
            loadArgs.fromEvent = fromEvent;
            loadArgs.direction = direction;
        }

        let events;

        // Get our events from the event index.
        try {
            events = await indexManager.loadFileEvents(loadArgs);
        } catch (e) {
            console.log("EventIndex: Error getting file events", e);
            return [];
        }

        const eventMapper = client.getEventMapper();

        // Turn the events into MatrixEvent objects.
        const matrixEvents = events.map(e => {
            const matrixEvent = eventMapper(e.event);

            const member = new RoomMember(room.roomId, matrixEvent.getSender());

            // We can't really reconstruct the whole room state from our
            // EventIndex to calculate the correct display name. Use the
            // disambiguated form always instead.
            member.name = e.profile.displayname + " (" + matrixEvent.getSender() + ")";

            // This is sets the avatar URL.
            const memberEvent = eventMapper(
                {
                    content: {
                        membership: "join",
                        avatar_url: e.profile.avatar_url,
                        displayname: e.profile.displayname,
                    },
                    type: "m.room.member",
                    event_id: matrixEvent.getId() + ":eventIndex",
                    room_id: matrixEvent.getRoomId(),
                    sender: matrixEvent.getSender(),
                    origin_server_ts: matrixEvent.getTs(),
                    state_key: matrixEvent.getSender(),
                },
            );

            // We set this manually to avoid emitting RoomMember.membership and
            // RoomMember.name events.
            member.events.member = memberEvent;
            matrixEvent.sender = member;

            return matrixEvent;
        });

        return matrixEvents;
    }

    /**
     * Fill a timeline with events that contain URLs.
     *
     * @param {TimelineSet} timelineSet The TimelineSet the Timeline belongs to,
     * used to check if we're adding duplicate events.
     *
     * @param {Timeline} timeline The Timeline which should be filed with
     * events.
     *
     * @param {Room} room The room for which we should fetch events containing
     * URLs
     *
     * @param {number} limit The maximum number of events to fetch.
     *
     * @param {string} fromEvent From which event should we continue fetching
     * events from the index. This is only needed if we're continuing to fill
     * the timeline, e.g. if we're paginating. This needs to be set to a event
     * id of an event that was previously fetched with this function.
     *
     * @param {string} direction The direction in which we will continue
     * fetching events. EventTimeline.BACKWARDS to continue fetching events that
     * are older than the event given in fromEvent, EventTimeline.FORWARDS to
     * fetch newer events.
     *
     * @returns {Promise<boolean>} Resolves to true if events were added to the
     * timeline, false otherwise.
     */
    async populateFileTimeline(timelineSet, timeline, room, limit = 10,
                               fromEvent = null, direction = EventTimeline.BACKWARDS) {
        const matrixEvents = await this.loadFileEvents(room, limit, fromEvent, direction);

        // If this is a normal fill request, not a pagination request, we need
        // to get our events in the BACKWARDS direction but populate them in the
        // forwards direction.
        // This needs to happen because a fill request might come with an
        // exisitng timeline e.g. if you close and re-open the FilePanel.
        if (fromEvent === null) {
            matrixEvents.reverse();
            direction = direction == EventTimeline.BACKWARDS ? EventTimeline.FORWARDS: EventTimeline.BACKWARDS;
        }

        // Add the events to the timeline of the file panel.
        matrixEvents.forEach(e => {
            if (!timelineSet.eventIdToTimeline(e.getId())) {
                timelineSet.addEventToTimeline(e, timeline, direction == EventTimeline.BACKWARDS);
            }
        });

        // Set the pagination token to the oldest event that we retrieved.
        if (matrixEvents.length > 0) {
            timeline.setPaginationToken(matrixEvents[matrixEvents.length - 1].getId(), EventTimeline.BACKWARDS);
            return true;
        } else {
            timeline.setPaginationToken("", EventTimeline.BACKWARDS);
            return false;
        }
    }

    /**
     * Emulate a TimelineWindow pagination() request with the event index as the event source
     *
     * Might not fetch events from the index if the timeline already contains
     * events that the window isn't showing.
     *
     * @param {Room} room The room for which we should fetch events containing
     * URLs
     *
     * @param {TimelineWindow} timelineWindow The timeline window that should be
     * populated with new events.
     *
     * @param {string} direction The direction in which we should paginate.
     * EventTimeline.BACKWARDS to paginate back, EventTimeline.FORWARDS to
     * paginate forwards.
     *
     * @param {number} limit The maximum number of events to fetch while
     * paginating.
     *
     * @returns {Promise<boolean>} Resolves to a boolean which is true if more
     * events were successfully retrieved.
     */
    paginateTimelineWindow(room, timelineWindow, direction, limit) {
        const tl = timelineWindow.getTimelineIndex(direction);

        if (!tl) return Promise.resolve(false);
        if (tl.pendingPaginate) return tl.pendingPaginate;

        if (timelineWindow.extend(direction, limit)) {
            return Promise.resolve(true);
        }

        const paginationMethod = async (timelineWindow, timeline, room, direction, limit) => {
            const timelineSet = timelineWindow._timelineSet;
            const token = timeline.timeline.getPaginationToken(direction);

            const ret = await this.populateFileTimeline(timelineSet, timeline.timeline, room, limit, token, direction);

            timeline.pendingPaginate = null;
            timelineWindow.extend(direction, limit);

            return ret;
        };

        const paginationPromise = paginationMethod(timelineWindow, tl, room, direction, limit);
        tl.pendingPaginate = paginationPromise;

        return paginationPromise;
    }
}
