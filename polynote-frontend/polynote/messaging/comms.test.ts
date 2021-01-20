import WS from "jest-websocket-mock";
import {__testExports, SocketSession} from "./comms";
import {superSecretKey} from "../../jest.setup";
import {KeepAlive, LoadNotebook, Message} from "../data/messages";

const wsUrl = __testExports["wsUrl"];
const closeAll = __testExports["closeAll"];
const openSessions = __testExports["openSessions"];

describe("wsUrl", () => {
    test("chooses the right protocol", () => {
        expect(wsUrl(new URL('http://localhost:8192/')).protocol).toEqual('ws:')
        expect(wsUrl(new URL('ws://localhost:8192/')).protocol).toEqual('ws:')
        expect(wsUrl(new URL('https://localhost:8192/')).protocol).toEqual('wss:')
        expect(wsUrl(new URL('wss://localhost:8192/')).protocol).toEqual('wss:')
    })

    test("appends the super-secret key!", () => {
        expect(wsUrl(new URL('http://localhost:8192/')).searchParams).toEqual(new URLSearchParams({'key': superSecretKey}))
    })
})

afterEach(() => {
    WS.clean();
    closeAll()
});

describe("SocketSession", () => {
    test("properly connects and keeps track of the global session as well as multiple notebook sessions", async () => {
        const globalServer = new WS('ws://localhost/ws');
        globalServer.on("message",  e => { console.log("hi", e)})
        const globalClient = SocketSession.global
        await globalServer.connected

        const relServer1 = new WS('ws://localhost/one');
        const relClient1 = SocketSession.fromRelativeURL("one")
        await relServer1.connected

        const relServer2 = new WS('ws://localhost/two');
        const relClient2 = SocketSession.fromRelativeURL("two")
        await relServer2.connected

        expect(Object.keys(openSessions)).toEqual([globalClient.url.href, relClient1.url.href, relClient2.url.href])
    })

    function createClient(relativeURL: string, constructor: (url: string) => SocketSession = SocketSession.fromRelativeURL) {
        const client = constructor(relativeURL)

        // we need to do this stupid thing because the event generated by the websocket mocking lib is an instance of a different `MessageEvent`
        const clientSocket = client["socket"]!
        clientSocket.removeEventListener("message",client.listeners.message)
        client.listeners.message = (evt: Event) => {
            client.receive(new MessageEvent(evt.type, {data: (evt as MessageEvent).data}))
        };
        clientSocket.addEventListener("message",client.listeners.message)

        return client
    }

    test("sends and receives encoded messages", async () => {
        const server = new WS('ws://localhost/socket');
        const client = createClient("socket")
        await server.connected

        const message = new LoadNotebook("test")
        const encoded = Message.encode(message)
        client.send(message)
        await expect(server).toReceiveMessage(encoded)

        const received = new Promise(resolve => {
            client.addMessageListener(LoadNotebook, msg => {
                resolve(msg)
            })
        })
        server.send(Message.encode(message))
        await expect(received).resolves.toEqual(message.path)
    })

    test("can reconnect", async () => {
        const server = new WS('ws://localhost/socket');
        const client = createClient("socket")
        await server.connected
        expect(client.queue.length).toEqual(0)

        client.reconnect(false)
        await server.connected

        const message = new LoadNotebook("test")
        const encoded = Message.encode(message)
        client.send(message)
        await expect(server).toReceiveMessage(encoded)
    })

    test("can be opened after a previous client has closed", async () => {
        const server = new WS('ws://localhost/socket');
        const message = new LoadNotebook("test")
        const encoded = Message.encode(message)

        const client1 = createClient("socket")
        await server.connected
        expect(client1.queue.length).toEqual(0)

        client1.send(message)
        await expect(server).toReceiveMessage(encoded)
        client1.close()

        const client2 = createClient("socket")
        await server.connected
        expect(client2.queue.length).toEqual(0)

        client2.send(message)
        await expect(server).toReceiveMessage(encoded)
    })

    test("enqueues messages sent while closed", async () => {
        const server = new WS('ws://localhost/socket');
        const client = createClient("socket")
        await server.connected
        expect(client.queue.length).toEqual(0)

        const messages = [new LoadNotebook("one"), new LoadNotebook("two")]

        client.close()
        messages.forEach(msg => client.send(msg))
        client.reconnect(true)
        for (const res of messages.map(msg => Message.encode(msg))) {
            await expect(server).toReceiveMessage(res)
        }
    })

    test("sends keepalive messages and errors when they time out", async () => {
        const server = new WS('ws://localhost/socket');
        // `as any` hack used to get around private constructor...
        const interval = 10 // set KA interval
        const client = createClient("socket", url => new (SocketSession as any)(new URL(`ws://localhost/${url}`), [], [], interval))

        let resolved = false;
        const onError = new Promise(resolve => client.addEventListener("error", (evt: Event) => {
            resolve(evt)
        }))
        onError.then(() => {
            resolved = true
        })

        await server.connected

        const ka1 = Message.encode(new KeepAlive(1))
        await expect(server).toReceiveMessage(ka1)
        server.send(ka1)

        expect(resolved).toEqual(false) // shouldn't have errored yet

        const ka2 = Message.encode(new KeepAlive(2))
        const ka3 = Message.encode(new KeepAlive(3))
        await expect(server).toReceiveMessage(ka2)

        console.error = jest.fn()
        console.warn = jest.fn()

        server.send(ka3) // trigger error by sending message with wrong KA payload

        const expectedEvent = new CustomEvent('error', {detail: {cause: `KeepAlive timed out after ${interval} ms`}})
        await onError.then((err: CustomEvent) => expect(err.detail).toEqual(expectedEvent.detail))

        expect(console.error).toHaveBeenCalledWith(client.url.href, "Did not receive response to latest ping!")
        expect(console.warn).toHaveBeenCalledWith(client.url.href, "KeepAlive response didn't match! Expected", 2, "received", 3)
    })

    test("propagates websocket errors", async () => {
        const server = new WS('ws://localhost/socket');
        const client = createClient("socket")
        await server.connected

        let error: Event;
        const onError = new Promise(resolve => client.addEventListener("error", (evt: Event) => {
            error = evt;
            resolve(evt)
        }))

        server.error()

        await onError.then((err: CustomEvent) => expect(err.detail.cause).toBeDefined())

    })
})