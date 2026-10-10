import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { WebSocketFrame, type Event } from "@inbot/contracts/src/events.js";
import { api, ApiError } from "./api";

export function invalidateEvent(client: QueryClient, event: Event) {
  const keys =
    event.event_type === "domain.verified"
      ? ["domains", "inboxes"]
      : event.event_type.startsWith("draft.")
        ? ["draft", "drafts", "approvals", "inboxes", "threads", "thread"]
        : ["inboxes", "threads", "thread"];
  for (const key of keys) void client.invalidateQueries({ queryKey: [key] });
}

export function useLiveEvents() {
  const client = useQueryClient();
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let lastEventId: string | undefined;
    let failures = 0;
    const retryConnection = () => {
      if (disposed) return;
      retry = setTimeout(() => void connect(), Math.min(1000 * 2 ** failures++, 30_000));
    };
    const connect = async () => {
      try {
        const connection = await api.eventsSocket(window.location.href, lastEventId);
        if (disposed) {
          connection.close();
          return;
        }
        socket = connection;
        const resetHeartbeat = () => {
          clearTimeout(heartbeat);
          heartbeat = setTimeout(() => connection.close(), 45_000);
        };
        connection.onopen = () => {
          connection.send(JSON.stringify({ type: "subscribe" }));
          resetHeartbeat();
        };
        connection.onmessage = (message) => {
          let frame: WebSocketFrame;
          try {
            frame = Schema.decodeUnknownSync(WebSocketFrame)(JSON.parse(String(message.data)));
          } catch {
            connection.close();
            return;
          }
          resetHeartbeat();
          if (frame.type === "ping") connection.send(JSON.stringify({ type: "pong" }));
          else if (frame.type === "event") {
            invalidateEvent(client, frame);
            lastEventId = frame.event_id;
          } else {
            failures = 0;
            for (const key of [
              "inboxes",
              "threads",
              "thread",
              "draft",
              "drafts",
              "approvals",
              "domains",
              "webhooks",
            ])
              void client.invalidateQueries({ queryKey: [key] });
          }
        };
        connection.onclose = (event) => {
          clearTimeout(heartbeat);
          if (event.code === 1008) void client.invalidateQueries({ queryKey: ["owner"] });
          retryConnection();
        };
      } catch (error) {
        if (error instanceof ApiError && (error.code === "unauthorized" || error.code === "locked"))
          void client.invalidateQueries({ queryKey: ["owner"] });
        else retryConnection();
      }
    };
    void connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(heartbeat);
      socket?.close();
    };
  }, [client]);
}
