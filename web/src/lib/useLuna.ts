// The WebSocket to luna-web, with automatic reconnect.
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ClientMessage, PauseReply, ServerEvent } from "./protocol";
import { initialState, reducer } from "./state";

function socketUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export function useLuna(onEvent?: (event: ServerEvent) => void) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const ws = useRef<WebSocket | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const sock = new WebSocket(socketUrl());
      ws.current = sock;
      sock.onopen = () => {
        retry = 0;
        dispatch({ kind: "connected" });
      };
      sock.onmessage = (msg) => {
        const event = JSON.parse(msg.data) as ServerEvent;
        dispatch({ kind: "server", event });
        handler.current?.(event);
      };
      sock.onclose = () => {
        if (ws.current === sock) ws.current = null;
        dispatch({ kind: "disconnected" });
        if (closed) return;
        retry += 1;
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState !== WebSocket.OPEN) return false;
    ws.current.send(JSON.stringify(msg));
    return true;
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || !send({ type: "message", text: clean })) return false;
      dispatch({ kind: "user", text: clean });
      return true;
    },
    [send],
  );

  const answer = useCallback(
    (answers: Record<string, PauseReply>) => {
      if (send({ type: "resume", answers })) dispatch({ kind: "answered" });
    },
    [send],
  );

  const setModel = useCallback(
    (provider: string, model: string) => {
      if (send({ type: "set_model", provider, model })) dispatch({ kind: "switching" });
    },
    [send],
  );

  return { state, send, sendMessage, answer, setModel };
}
