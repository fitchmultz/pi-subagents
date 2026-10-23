import { rawKeyHint, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText, type Component } from "@earendil-works/pi-tui";
import { actionHints, actionText } from "../shared/tui-action.ts";
import { HStack, ScrollView, type VStack } from "./observe-layout.ts";
import type { Launch } from "./contracts.ts";
import { plainText } from "./journal-tail.ts";

export interface ObserverRow {
  id: string;
  name: string;
  status: string;
  live: boolean;
  createdAt: number;
  activity?: string;
}

export class Details extends ScrollView {
  constructor(launch: Launch) {
    super(
      new Text(
        `${launch.context === "fork" ? "Fork context: includes inherited parent activity.\n" : ""}${launch.id}\nAssignment preview: ${plainText(launch.prompt, 160)}\n${launch.sessionFile}`,
        0,
        0,
      ),
      { primary: false, scrollbar: "always" },
    );
  }
}

export class ChildList extends ScrollView {
  private readonly list: Container;
  private readonly open: (id: string) => void;
  constructor(open: (id: string) => void) {
    const list = new Container();
    super(list, { primary: false, scrollbar: "always" });
    this.list = list;
    this.open = open;
  }
  update(rows: ObserverRow[], selected: string, checking: boolean): void {
    this.list.clear();
    if (rows.length === 0) {
      this.list.addChild(
        new Text(
          checking
            ? "Checking saved child runs…"
            : "No child runs to show. Completed runs are hidden.",
          0,
          0,
        ),
      );
    }
    for (const row of rows) {
      this.list.addChild(
        actionText(`${row.id === selected ? ">" : " "} ${row.status} · ${row.name}`, () =>
          this.open(row.id),
        ),
      );
    }
  }
  reveal(index: number): void {
    this.scrollTo(Math.max(0, index - Math.floor(this.viewportHeight / 2)));
  }
}

export type ScreenAction = [Parameters<KeybindingsManager["matches"]>[1], string, () => void];

/** Header activity label: a live connection wins over the last known row status. */
export function activityLabel(options: {
  row: ObserverRow | undefined;
  client: { connected: boolean; activity: string } | undefined;
  connecting: boolean;
}): string {
  const { row, client } = options;
  if (row?.live !== true) {
    return row?.status ?? "checking";
  }
  if (client?.connected === true) {
    return client.activity;
  }
  if (client) {
    return "Reconnecting";
  }
  return options.connecting ? "Connecting" : (row.activity ?? row.status);
}

/** Footer key hints press the same actions as the keyboard table. */
export function appendHints(
  target: InstanceType<typeof VStack>,
  options: {
    actions: readonly ScreenAction[];
    keys: KeybindingsManager;
    perform: (action: () => void) => void;
  },
): void {
  const hints = options.actions
    .filter(([, label]) => label.length > 0)
    .map(([key, label, action]) => ({
      text: rawKeyHint(options.keys.getKeys(key)[0] ?? "", label),
      action: () => options.perform(action),
    }));
  target.addChild(actionHints(hints), { basis: 1 });
}

/** Conversation body: persistent child strip beside the transcript, plus the follow footer. */
export function appendConversation(
  target: InstanceType<typeof VStack>,
  options: {
    list: ChildList;
    reading: { scroll: Component; following: boolean; pending: boolean };
    follow: () => void;
  },
): void {
  target.addChild(
    new HStack(
      [
        {
          component: options.list,
          basis: 27,
          visible: (viewport) => viewport.width >= 100,
        },
        { component: options.reading.scroll, basis: 0, grow: 1, minSize: 1 },
      ],
      { gap: 1 },
    ),
    { basis: 0, grow: 1, minSize: 1 },
  );
  const { following, pending } = options.reading;
  let follow = pending
    ? "New activity below · End to follow live"
    : "Reading earlier · End to follow live";
  if (following) {
    follow = "Following live";
  }
  target.addChild(actionText(follow, options.follow), { basis: 1 });
}

export function appendHeader(
  target: InstanceType<typeof VStack>,
  options: {
    launch: Launch;
    model: string;
    thinking: string;
    activity: string;
    details?: Details;
    toggle: () => void;
  },
): void {
  const { launch } = options;
  target.addChild(
    actionText(
      `${plainText(launch.name ?? "Child", 32)} · ${options.activity} · Details`,
      options.toggle,
    ),
    { basis: 1 },
  );
  target.addChild(new TruncatedText(`${options.model} · Thinking ${options.thinking}`, 0, 0), {
    basis: 1,
  });
  if (options.details) {
    target.addChild(options.details, { maxSize: 5 });
  }
}
