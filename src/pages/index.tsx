import * as React from "react";
import type { NextPage } from "next";
import Paper from "@mui/material/Paper";
import { useImmer } from "use-immer";
import { nanoid } from "nanoid";
import { getCurrent } from "@tauri-apps/api/window";

import styles from "./index.module.css";

const setImmediate = (f: () => void) => setTimeout(f, 0);

type CommentElement =
    | {
          type: "text";
          content: string;
      }
    | {
          type: "emoji";
          url: string;
      };

type Comment = {
    id: string;
    elements: Array<CommentElement>;
};

type CommentPaperProps = { comment: Comment; styles?: React.CSSProperties };
const CommentPaper: React.FC<CommentPaperProps> = ({ comment, styles: s }) => (
    <Paper className={styles["comment-paper"]} style={s}>
        {comment.elements.map((v, i) => {
            switch (v.type) {
                case "text":
                    return <span key={i}>{v.content}</span>;
                case "emoji":
                    return <img key={i} src={v.url} style={{ height: "1.2em" }} />;
            }
        })}
    </Paper>
);

function assertNotNull<T>(v: T | null | undefined): asserts v is Exclude<T, null | undefined> {
    console.assert(v != null);
}

class CommentEventBus {
    public constructor(private eventListeners: Record<string, (c: Comment) => void> = {}) {}

    // returns ID of listener to use on removeListner method.
    public listen(f: (c: Comment) => void): string {
        const id = nanoid();
        this.eventListeners[id] = f;
        return id;
    }

    public removeListener(id: string): void {
        delete this.eventListeners[id];
    }

    public emit(c: Comment): void {
        for (const listener of Object.values(this.eventListeners)) {
            listener(c);
        }
    }
}

const elementHeight = (element: HTMLElement, includeMargin = true) => {
    if (element == null) {
        return 0;
    }

    const styles = window.getComputedStyle(element);
    const margin = includeMargin
        ? parseFloat(styles["marginTop"]) + parseFloat(styles["marginBottom"])
        : 0;

    return element.offsetHeight + margin;
};

type RenderedComment = {
    top: number;
    height: number;
    comment: Comment;
};

type CommentsProps = {
    eventBus: CommentEventBus;
};

const Comments: React.FC<CommentsProps> = ({ eventBus }) => {
    const containerRef = React.useRef<HTMLDivElement>(null);

    // prettier-ignore
    const [shownCommentLayers, setShownCommentLayers] =
        useImmer<[Array<RenderedComment>, Array<RenderedComment>]>([[], []]);
    const [appendingLayer, setAppendingLayer] = React.useState(0);

    const [tryPutComment, setTryPutComment] = React.useState<Comment | null>(null);

    React.useEffect(() => {
        const id = eventBus.listen((c) => {
            setTryPutComment((old) => {
                if (old != null) {
                    console.warn("comment eventbus listener: TryPut collision");
                }
                return c;
            });
        });
        return () => eventBus.removeListener(id);
    }, [eventBus]);

    React.useLayoutEffect(() => {
        if (tryPutComment == null) {
            return;
        }

        // mesuring queued. let's measure its height and put it to desired layer.
        assertNotNull(containerRef.current);
        const children = containerRef.current.children;

        const target = children[0] as HTMLElement;
        const height = elementHeight(target);
        console.assert(height !== 0);

        // |(1-1)| => 0
        // |(0-1)| => |-1| => 1
        const alternateLayer = (x: number) => Math.abs(x - 1);

        const containerHeight = containerRef.current.clientHeight;
        let oldLayer = alternateLayer(appendingLayer);
        let currentLayer = appendingLayer;
        let usedHeight = shownCommentLayers[currentLayer]
            .map((x) => x.height)
            .reduce((a, b) => a + b, 0);

        if (usedHeight + height > containerHeight) {
            oldLayer = appendingLayer;
            currentLayer = alternateLayer(appendingLayer);
            usedHeight = 0;

            setAppendingLayer(currentLayer);
        }

        const oldLayerTop = shownCommentLayers[oldLayer].reduce(
            (a, b) => Math.min(a, b.top),
            Infinity
        );

        const leftSpace = oldLayerTop - usedHeight;
        let remainingHeight = height - leftSpace;
        let deleteCount = 0;

        for (const c of shownCommentLayers[oldLayer]) {
            if (remainingHeight <= 0) {
                break;
            }

            deleteCount += 1;
            remainingHeight -= c.height;
        }

        setShownCommentLayers((comments) => {
            for (let i = 0; i < deleteCount; i++) {
                comments[oldLayer].shift();
            }
            comments[currentLayer].push({ top: usedHeight, height, comment: tryPutComment });
            comments.forEach((x) => x.sort((a, b) => a.top - b.top));
        });

        setTryPutComment(null);

    }, [containerRef, shownCommentLayers, tryPutComment, appendingLayer, setShownCommentLayers]);

    const commentsOffset = (() => {
        const container = containerRef.current;
        if (container == null) return 0;

        const style = window.getComputedStyle(container);
        return container.offsetTop + parseFloat(style["paddingTop"]);
    })();

    const inner = [];

    if (tryPutComment != null) {
        inner.push(<CommentPaper comment={tryPutComment} />);
    }

    inner.push(
        ...shownCommentLayers.flatMap((x) =>
            x.map((ct) => {
                const styles: React.CSSProperties = {
                    top: `${ct.top + commentsOffset}px`,
                    position: "absolute",
                };
                return <CommentPaper key={ct.comment.id} {...{ comment: ct.comment, styles }} />;
            })
        )
    );

    return (
        <div className={styles["comment-container"]} ref={containerRef}>
            {inner}
        </div>
    );
};

type Stats = {
    commentsPerSec: number;
    shownComments: number;
}

const StatsPaper: React.FC<{stats: Stats | null}> = ({stats}) => (
    <Paper className={styles["stats-container"]}>
        <p>total comments: {stats?.shownComments ?? 0}</p>
        <p>speed: {stats?.commentsPerSec?.toFixed(2) ?? "n/a"} comments/s</p>
    </Paper>
)

type StatsEvent = {
    commentsPerSec: number;
}

const Home: NextPage = () => {
    // CSR for useLayoutEffect
    const [visible, setVisible] = React.useState(false);
    const [stats, setStats] = React.useState<StatsEvent | null>(null);
    const [commentCount, setCommentCount] = React.useState(0);
    const eventBus = React.useRef(new CommentEventBus());

    React.useEffect(() => {
        setVisible(true);
        (async () => {
            try {
                const current = getCurrent()
                await current.listen("comment", (e) => {
                    const elements = (e as any).payload.elements as Array<CommentElement>;
                    const comment = { id: nanoid(), elements };
                    setCommentCount(x => x + 1);
                    eventBus.current.emit(comment);
                });
                await current.listen("stats", (e) => {
                    setStats((e as any).payload);
                });
            } catch (e) {
                console.warn("i'm not on tauri! putting some sample comments");
                for (const c of sampleComments) {
                    setImmediate(() => eventBus.current.emit(c));
                }
            }
        })();
    }, []);

    let propStats: Stats | null = null;
    if (stats != null) {
        propStats = {
            commentsPerSec: stats.commentsPerSec,
            shownComments: commentCount
        };
    }

    return !visible ? null : (
        <div className={styles["index-container"]}>
            <Comments eventBus={eventBus.current} />
            <StatsPaper stats={propStats} />
        </div>
    );
};

const sampleComments: Array<Comment> = [
    {
        id: nanoid(),
        elements: [{ type: "text", content: "This is a test text. AAAAAAAAAA" }],
    },
    {
        id: nanoid(),
        elements: [{ type: "text", content: "This is also test text. BBBBBBBBBBBBBBBBBBBB" }],
    },
    {
        id: nanoid(),
        elements: [{ type: "text", content: "This is the last test text. CCCC" }],
    },
];

export default Home;
