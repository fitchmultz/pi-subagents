import {
  MouseRegion,
  TruncatedText,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

export function actionText(text: string, action: (column: number) => void): Component {
  const component = new TruncatedText(text, 0, 0);
  return new MouseRegion(component, (event) => {
    if (
      (event.type !== "press" && event.type !== "click") ||
      event.button !== "left" ||
      event.x >= visibleWidth(truncateToWidth(text, event.width))
    ) {
      return;
    }
    if (event.type === "click") {
      action(event.x);
    }
    return { handled: true, render: event.type === "click" };
  });
}
