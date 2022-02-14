import * as React from "react";
import * as ReactDOM from "react-dom";
import Paper from "@mui/material/Paper";
import { useImmer } from "use-immer";
import { nanoid } from "nanoid";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import "./globals.css";

import { getCurrent } from "@tauri-apps/api/window";

import styles from "./index.module.css";

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
            const ty = v.type;
            switch (ty) {
                case "text":
                    return <span key={i}>{v.content}</span>;
                case "emoji":
                    return <img key={i} src={v.url} alt="emoji" style={{ height: "1.2em" }} />;
                default:
                    console.warn(`unknown comment type: ${ty}`);
                    return null;
            }
        })}
    </Paper>
);

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
                    console.warn("comment eventbus listener: tryPut collision");
                }
                return c;
            });
        });
        return () => eventBus.removeListener(id);
    }, [eventBus]);

    // 1. Receive comment from `eventBus`.
    // 2. Put it into `tryPutComment` and apply to DOM to measure its height.
    // 3. Immediately call `useLayoutEffect` to update `shownCommentLayers`
    // 4. Delete comments which will collide with.
    // 5. Move comment `tryPutComment` to `shownCommentLayers`.
    React.useLayoutEffect(() => {
        if (tryPutComment == null) {
            return;
        }

        if (containerRef.current == null) {
            return;
        }

        const children = containerRef.current.children;
        const containerHeight = containerRef.current.clientHeight;

        const target = children[0] as HTMLElement;
        const height = elementHeight(target);
        console.assert(height !== 0);

        // |(1-1)| => 0
        // |(0-1)| => |-1| => 1
        const alternateLayer = (x: number) => Math.abs(x - 1);

        let oldLayer = alternateLayer(appendingLayer);
        let currentLayer = appendingLayer;
        let usedHeight = shownCommentLayers[currentLayer]
            .map((x) => x.height)
            .reduce((a, b) => a + b, 0);

        if (usedHeight + height > containerHeight) {
            // Delete trailling comments
            const count = shownCommentLayers[appendingLayer].filter(
                (x) => x.top > usedHeight,
            ).length;
            setShownCommentLayers((comments) => {
                for (let i = 0; i < count; i++) {
                    comments[appendingLayer].pop();
                }
            });

            oldLayer = appendingLayer;
            currentLayer = alternateLayer(appendingLayer);
            usedHeight = 0;

            setAppendingLayer(currentLayer);
        }

        const oldLayerTop = shownCommentLayers[oldLayer].reduce(
            (a, b) => Math.min(a, b.top),
            Infinity,
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

            comments[currentLayer].push({
                height,
                top: usedHeight,
                comment: tryPutComment,
            });

            comments.forEach((layer) => layer.sort((a, b) => a.top - b.top));
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
        inner.push(<CommentPaper key={tryPutComment.id} comment={tryPutComment} />);
    }

    inner.push(
        ...shownCommentLayers.flatMap((layer) =>
            layer.map((comment) => {
                const styles: React.CSSProperties = {
                    top: `${comment.top + commentsOffset}px`,
                    position: "absolute",
                };
                return (
                    <CommentPaper
                        key={comment.comment.id}
                        comment={comment.comment}
                        styles={styles}
                    />
                );
            }),
        ),
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
};

const StatsPaper: React.FC<{ stats: Stats | null }> = ({ stats }) => (
    <Paper className={styles["stats-container"]}>
        <p>total comments: {stats?.shownComments ?? 0}</p>
        <p>speed: {stats?.commentsPerSec?.toFixed(2) ?? "n/a"} comments/s</p>
    </Paper>
);

type StatsEvent = {
    commentsPerSec: number;
};

const Home = () => {
    const theme = React.useMemo(() => createTheme({ palette: { mode: "dark" } }), []);
    const [stats, setStats] = React.useState<StatsEvent | null>(null);
    const [commentCount, setCommentCount] = React.useState(0);
    const eventBus = React.useRef(new CommentEventBus());

    React.useEffect(() => {
        (async () => {
            const current = getCurrent();

            await current.listen("comment", (e) => {
                const elements = (e as any).payload.elements as Array<CommentElement>;
                const comment = { id: nanoid(), elements };
                setCommentCount((x) => x + 1);
                eventBus.current.emit(comment);
            });

            await current.listen("stats", (e) => {
                setStats((e as any).payload);
            });
        })();
    }, []);

    let propStats: Stats | null = null;
    if (stats != null) {
        propStats = {
            commentsPerSec: stats.commentsPerSec,
            shownComments: commentCount,
        };
    }

    return (
        <ThemeProvider theme={theme}>
            <div className={styles["index-container"]}>
                <Comments eventBus={eventBus.current} />
                <StatsPaper stats={propStats} />
            </div>
        </ThemeProvider>
    );
};

ReactDOM.render(
    <React.StrictMode>
        <Home />
    </React.StrictMode>,
    document.getElementById("root"),
);
