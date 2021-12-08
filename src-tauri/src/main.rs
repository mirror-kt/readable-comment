#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use anyhow::{Context as _, Result};
use headless_chrome::{
    protocol::network::{
        events::ResponseReceivedEventParams, methods::GetResponseBodyReturnObject,
    },
    Browser, LaunchOptionsBuilder, Tab,
};
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::Poll,
    time::{Duration, Instant},
};
use tauri::Window;
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

    // failure::Error doesn't implement std::error::Error.
    let (_browser, _tab) = YoutubeListener::new(Arc::clone(&context), todo!("put video id here"))
        .start()
        .expect("failed to initialize youtube listener");

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

    pub(crate) fn start(self) -> Result<(Browser, Arc<Tab>), failure::Error> {
        let opt = LaunchOptionsBuilder::default()
            .headless(false)
            .build()
            .unwrap();

        let browser = Browser::new(opt)?;
        let tab = browser.wait_for_initial_tab()?;

        tab.enable_log()?;

        tab.navigate_to(&format!(
            "https://www.youtube.com/live_chat?v={}",
            self.inner.video_id
        ))?;

        tab.enable_response_handling(Box::new(move |a, b| self.on_response(a, b)))?;

        // why this element has this too short ID?
        tab.wait_for_element_with_custom_timeout("#label", Duration::from_secs(10))?
            .click()?;

        std::thread::sleep(Duration::from_millis(500));

        tab.wait_for_element("#menu > a:nth-child(2) > tp-yt-paper-item")?
            .click()?;

        Ok((browser, tab))
    }

    fn on_response(
        &self,
        param: ResponseReceivedEventParams,
        fetch: &dyn Fn() -> Result<GetResponseBodyReturnObject, failure::Error>,
    ) {
        if !param
            .response
            .url
            .starts_with("https://www.youtube.com/youtubei/v1/live_chat/get_live_chat")
        {
            return;
        }

        const POLL_COUNT: usize = 50;
        const POLL_INTERVAL: Duration = Duration::from_millis(100);

        let id = param.request_id;

        // TODO: use tracing's span
        // Wait for chromium to fetch response's body
        // we don't have a way to be notified when chromium completed to fetch,
        // so using polling instead.
        'poll: for _ in 0..POLL_COUNT {
            std::thread::sleep(POLL_INTERVAL);
            match fetch() {
                Ok(data) if data.body.trim().is_empty() => {
                    tracing::warn!("id: {}: empty body. retrying", id);
                    continue 'poll;
                }

                Ok(data) => {
                    // We should return from this function as soon as possible because
                    // this `on_response` function is called by headless_chrome crate
                    // *synchronously in event loop*. Blocking on this function too long time
                    // causes dropping browser event or connection lost.
                    // This is why using `spawn` instead of `block_on`.
                    let inner = Arc::clone(&self.inner);
                    self.inner
                        .ctx
                        .rt
                        .spawn(async move { inner.on_comment(data.body).await });
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
}

impl YoutubeListenerInner {
    async fn on_comment(&self, json_str: String) {
        let raw: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        let comments = match Self::parse_json(&raw) {
            Some(t) => t,
            None => return,
        };

        let normalize_duration = {
            // used on first fetch where last_comment_fetch isn't set
            const DEFAULT_FETCH_PERIOD_SECS: f64 = 5.2;

            let now = Instant::now();
            let elapsed_time_from_last_fetch = self
                .last_comment_fetch
                .lock()
                .await
                .replace(now)
                .map(|x| now - x)
                .unwrap_or(Duration::from_secs_f64(DEFAULT_FETCH_PERIOD_SECS));

            let mut comment_fetch_period = self.comment_fetch_period.lock().await;
            comment_fetch_period.put(elapsed_time_from_last_fetch);

            let average = comment_fetch_period.average();
            average
        };

        let comments_per_sec = comments.len() as f64 / normalize_duration.as_secs_f64();

        self.emit("stats", Stats { comments_per_sec }).await;

        let sleep_time_of_one_loop = normalize_duration / (comments.len() as u32);
        for c in comments {
            self.emit("comment", c).await;
            tokio::time::sleep(sleep_time_of_one_loop).await;
        }
    }

    async fn emit(&self, event: &str, payload: impl serde::Serialize) {
        let webview = self.ctx.webview.lock().await;

        if let Some(w) = webview.as_ref() {
            w.emit(event, payload)
                .expect("failed to emit event to webview");
        } else {
            tracing::warn!(
                "failed to emit event \"{}\" because webview is not initialized yet.",
                event
            )
        }
    }

    fn parse_json(raw: &serde_json::Value) -> Option<Vec<SerializedComment<'_>>> {
        let comments = raw
            .get("continuationContents")?
            .get("liveChatContinuation")?
            .get("actions")?
            .as_array()?
            .iter()
            .flat_map(|x| {
                Some(
                    x.get("addChatItemAction")?
                        .get("item")?
                        .get("liveChatTextMessageRenderer")?
                        .get("message")?
                        .get("runs")?
                        .as_array()?,
                )
            })
            .map(|r| r.iter().flat_map(Self::run_to_element).collect())
            .flat_map(SerializedComment::new)
            .collect();

        Some(comments)
    }

    fn run_to_element(run: &serde_json::Value) -> Option<CommentElement<'_>> {
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
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    comments_per_sec: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializedComment<'a> {
    elements: Vec<CommentElement<'a>>,
}

impl<'a> SerializedComment<'a> {
    fn new(elements: Vec<CommentElement<'a>>) -> Option<Self> {
        if elements.is_empty() {
            None
        } else {
            Some(Self { elements })
        }
    }
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
