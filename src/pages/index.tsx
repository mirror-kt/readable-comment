import * as React from "react";
import type { NextPage } from "next";
import Paper from "@mui/material/Paper";
import { useImmer } from "use-immer";
import { nanoid } from "nanoid";
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
    const commentRef = React.useRef<HTMLDivElement>(null);

    // prettier-ignore
    const [shownCommentLayers, setShownCommentLayers] =
        useImmer<[Array<RenderedComment>, Array<RenderedComment>]>([[], []]);
    const [appendingLayer, setAppendingLayer] = React.useState(0);

    const [tryPutComment, setTryPutComment] = React.useState<Comment | null>(null);

    React.useEffect(() => {
        const id = eventBus.listen((c) => {
            setTryPutComment((old) => {
                // likely happen in heavy load, but i have no idea to prevent this.
                console.assert(old == null);
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
        assertNotNull(commentRef.current);
        const children = commentRef.current.children;

        const target = children[0] as HTMLElement;
        const height = elementHeight(target);
        console.assert(height !== 0);

        // |(1-1)| => 0
        // |(0-1)| => |-1| => 1
        const alternateLayer = (x: number) => Math.abs(x - 1);

        const containerHeight = commentRef.current.clientHeight;
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
    }, [commentRef, shownCommentLayers, tryPutComment, appendingLayer, setShownCommentLayers]);

    const inner = [];

    if (tryPutComment != null) {
        inner.push(<CommentPaper comment={tryPutComment} />);
    }

    inner.push(
        ...shownCommentLayers.flatMap((x) =>
            x.map((ct) => {
                const styles: React.CSSProperties = {
                    top: `${ct.top + 10}px`,
                    position: "absolute",
                };
                return <CommentPaper key={ct.comment.id} {...{ comment: ct.comment, styles }} />;
            })
        )
    );

    return (
        <div className={styles["comment-container"]} ref={commentRef}>
            {inner}
        </div>
    );
};

const Home: NextPage = () => {
    // CSR for useLayoutEffect
    const [visible, setVisible] = React.useState(false);
    const eventBus = React.useRef(new CommentEventBus());

    React.useEffect(() => {
        setVisible(true);
        (async () => {
            await getCurrent().listen("comment", (e) => {
                const elements = (e as any).payload.elements as Array<CommentElement>;
                const comment = { id: nanoid(), elements };
                eventBus.current.emit(comment);
            });
        })();
    }, []);

    return visible ? <Comments eventBus={eventBus.current} /> : null;
};

export default Home;
