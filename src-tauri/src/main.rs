#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use anyhow::{Context as _, Result};
use headless_chrome::{
    protocol::network::{
        events::ResponseReceivedEventParams, methods::GetResponseBodyReturnObject,
    },
    Browser, LaunchOptionsBuilder,
};
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::Poll,
    thread::sleep,
    time::{Duration, Instant},
};
use tauri::Window;
use tokio::task::block_in_place;
use tokio::{
    runtime::{Builder as TokioRuntimeBuilder, Runtime as TokioRuntime},
    sync::Mutex,
};

struct Context {
    rt: TokioRuntime,
    webview: Mutex<Option<Window>>,
}

fn main() -> Result<()> {
    dotenv::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let rt = TokioRuntimeBuilder::new_multi_thread()
        .enable_all()
        .build()
        .context("Failed to create tokio runtime")?;

    let context = Arc::new(Context {
        rt,
        webview: Mutex::new(None),
    });

    context
        .rt
        .spawn(YoutubeListener::new(Arc::clone(&context), todo!("put video id here")).start());

    tauri::Builder::default()
        .on_page_load(move |window, _| {
            context.rt.block_on(async {
                *context.webview.lock().await = Some(window);
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    Ok(())
}

// a future that never ends.
struct Empty;

impl Future for Empty {
    type Output = ();

    fn poll(self: Pin<&mut Self>, _: &mut std::task::Context<'_>) -> Poll<()> {
        Poll::Pending
    }
}

struct YoutubeListenerInner {
    ctx: Arc<Context>,
    video_id: String,
    comment_fetch_period: Mutex<CyclicArray<5>>,
    last_comment_fetch: Mutex<Option<Instant>>,
}

struct YoutubeListener {
    inner: Arc<YoutubeListenerInner>,
}

impl YoutubeListener {
    pub(crate) fn new(ctx: Arc<Context>, video_id: String) -> Self {
        Self {
            inner: Arc::new(YoutubeListenerInner {
                ctx,
                video_id,
                comment_fetch_period: Mutex::new(CyclicArray::new()),
                last_comment_fetch: Mutex::new(None),
            }),
        }
    }

    pub(crate) async fn start(self) {
        // starting browser is heavy task, so we must use block_in_place
        // for not blocking any task on the same thread.
        // also block_in_place must return browser and tab not to run their destructors.
        let (_browser, _tab) = block_in_place(move || {
            let opt = LaunchOptionsBuilder::default()
                .headless(false)
                .build()
                .unwrap();

            let browser = Browser::new(opt).unwrap();
            let tab = browser.new_tab().unwrap();

            tab.enable_log().unwrap();

            tab.navigate_to(&format!(
                "https://www.youtube.com/live_chat?v={}",
                self.inner.video_id
            ))
            .unwrap();

            tab.enable_response_handling(Box::new(move |a, b| self.on_response(a, b)))
                .unwrap();

            (browser, tab)
        });

        // prevent to run destructors
        Empty.await;
    }

    fn on_response(
        &self,
        param: ResponseReceivedEventParams,
        fetch: &dyn Fn() -> Result<GetResponseBodyReturnObject, failure::Error>,
    ) {
        tracing::trace!("fetch from {}", param.response.url);
        if !param
            .response
            .url
            .starts_with("https://www.youtube.com/youtubei/v1/live_chat/get_live_chat")
        {
            return;
        }

        const POLL_COUNT: usize = 10;
        const POLL_INTERVAL: Duration = Duration::from_millis(500);

        let id = param.request_id;

        // TODO: use tracing's span
        // Wait for chromium to fetch response's body
        // we don't have a way to be notified when chromium completed to fetch,
        // so using polling instead.
        'poll: for _ in 0..POLL_COUNT {
            sleep(POLL_INTERVAL);
            match fetch() {
                Ok(data) if data.body.trim().is_empty() => {
                    tracing::warn!("id: {}: empty body. retrying", id);
                    continue 'poll;
                }

                Ok(data) => {
                    self.on_comment(data.body);
                    return;
                }

                Err(e) => {
                    tracing::error!("id: {}: failed to fetch: {}", id, e);
                    return;
                }
            }
        }

        tracing::warn!("couldn't fetch request's body");
    }

    fn on_comment(&self, json_str: String) {
        let me = Arc::clone(&self.inner);
        let fut = async move {
            let raw: serde_json::Value = serde_json::from_str(&json_str).unwrap();
            let comments = Self::parse_json(&raw)?;

            let normalize_duration = {
                // used on first fetch where last_comment_fetch isn't set
                const DEFAULT_FETCH_PERIOD_SECS: f64 = 5.2;

                let now = Instant::now();
                let elapsed_time_from_last_fetch = me
                    .last_comment_fetch
                    .lock()
                    .await
                    .replace(now)
                    .map(|x| now - x)
                    .unwrap_or(Duration::from_secs_f64(DEFAULT_FETCH_PERIOD_SECS));

                let mut comment_fetch_period = me.comment_fetch_period.lock().await;
                comment_fetch_period.put(elapsed_time_from_last_fetch);

                let average = comment_fetch_period.average();
                average
            };

            tracing::trace!("comments: {}", comments.len());
            tracing::trace!("fetch_period: {:?}", me.comment_fetch_period.lock().await);
            tracing::info!(
                "{:.2} comments/s",
                comments.len() as f64 / normalize_duration.as_secs_f64()
            );
            let sleep_time_of_one_loop = normalize_duration / (comments.len() as u32);
            for c in comments {
                me.ctx
                    .webview
                    .lock()
                    .await
                    .as_ref()
                    .unwrap()
                    .emit("comment", c)
                    .unwrap();

                sleep(sleep_time_of_one_loop);
            }

            Some(())
        };

        self.inner.ctx.rt.spawn(fut);
    }

    fn parse_json(raw: &serde_json::Value) -> Option<Vec<SerializedComment<'_>>> {
        let comments = raw
            .get("continuationContents")?
            .get("liveChatContinuation")?
            .get("actions")?
            .as_array()?
            .iter()
            .flat_map(|x| {
                let t = x
                    .get("addChatItemAction")?
                    .get("item")?
                    .get("liveChatTextMessageRenderer")?;
                Some(t)
            })
            .flat_map(|x| {
                let runs = x.get("message")?.get("runs")?.as_array()?;
                Self::parse_message_runs(runs)
            })
            .collect::<Vec<SerializedComment>>();

        Some(comments)
    }

    fn parse_message_runs(runs: &Vec<serde_json::Value>) -> Option<SerializedComment<'_>> {
        let elements = runs
            .iter()
            .flat_map(|run| -> Option<CommentElement> {
                if let Some(emoji) = run.get("emoji") {
                    let image_candidates = emoji.get("image")?.get("thumbnails")?.as_array()?;
                    let image_object = match image_candidates.len() {
                        0 => return None,
                        1 => &image_candidates[0],
                        _ => image_candidates
                            .iter()
                            .flat_map(|x| {
                                // remove object which doesn't have width property
                                let width = x.get("width");
                                if matches!(width, Some(t) if t.is_i64()) {
                                    Some(x)
                                } else {
                                    None
                                }
                            })
                            .max_by_key(|x| x.get("width").unwrap().as_i64())?,
                    };

                    return Some(CommentElement::Emoji {
                        url: image_object.get("url")?.as_str()?,
                    });
                }

                if let Some(text) = run.get("text") {
                    return Some(CommentElement::Text {
                        content: text.as_str()?,
                    });
                }

                None
            })
            .collect::<Vec<_>>();

        if elements.len() == 0 {
            return None;
        }

        if elements.len() != 0 {
            Some(SerializedComment { elements })
        } else {
            None
        }
    }
}

#[derive(serde::Serialize)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
struct SerializedComment<'a> {
    elements: Vec<CommentElement<'a>>,
}

#[derive(serde::Serialize)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
enum CommentElement<'a> {
    Text { content: &'a str },
    Emoji { url: &'a str },
}

#[derive(Debug)]
struct CyclicArray<const N: usize> {
    value: [Duration; N],
    current_index: usize,
}

impl<const N: usize> CyclicArray<N> {
    fn new() -> Self {
        Self {
            value: [Duration::ZERO; N],
            current_index: 0,
        }
    }

    fn put(&mut self, value: Duration) {
        self.value[self.current_index] = value;
        if self.current_index >= N - 1 {
            self.current_index = 0;
        } else {
            self.current_index += 1;
        }
    }

    fn average(&self) -> Duration {
        let mut sum = Duration::ZERO;
        let mut count = 0;
        for d in self.value {
            if d != Duration::ZERO {
                count += 1;
                sum += d;
            }
        }
        sum / count
    }
}
