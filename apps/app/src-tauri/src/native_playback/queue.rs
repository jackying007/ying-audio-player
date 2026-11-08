use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Mode {
    #[default]
    Sequence,
    Shuffle,
    RepeatOne,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Step {
    Previous,
    Next,
    Ended,
}

#[derive(Default)]
pub(super) struct Queue {
    keys: Vec<String>,
    remaining: Vec<String>,
    history: Vec<String>,
    cursor: usize,
}

impl Queue {
    pub(super) fn reset(&mut self, keys: Vec<String>, current: Option<&str>) {
        self.history = current
            .filter(|key| keys.iter().any(|item| item == key))
            .map(|key| vec![key.to_owned()])
            .unwrap_or_default();
        self.cursor = 0;
        self.remaining = keys
            .iter()
            .filter(|key| Some(key.as_str()) != current)
            .cloned()
            .collect();
        fastrand::shuffle(&mut self.remaining);
        self.keys = keys;
    }

    pub(super) fn can_step(&self, mode: Mode, step: Step) -> bool {
        !self.keys.is_empty()
            && (mode != Mode::Shuffle || step != Step::Previous || self.cursor > 0)
    }

    pub(super) fn select(
        &mut self,
        mode: Mode,
        step: Step,
        current: Option<&str>,
    ) -> Option<String> {
        if !self.can_step(mode, step) {
            return None;
        }
        if mode == Mode::RepeatOne && step == Step::Ended && current.is_some() {
            return current.map(str::to_owned);
        }
        if mode != Mode::Shuffle {
            let len = self.keys.len();
            let index = current.and_then(|key| self.keys.iter().position(|item| item == key));
            return Some(
                self.keys[match (step, index) {
                    (Step::Previous, Some(i)) => (i + len - 1) % len,
                    (_, Some(i)) => (i + 1) % len,
                    (Step::Previous, None) => len - 1,
                    (_, None) => 0,
                }]
                .clone(),
            );
        }
        if step == Step::Previous {
            self.cursor -= 1;
            return self.history.get(self.cursor).cloned();
        }
        if self.cursor + 1 < self.history.len() {
            self.cursor += 1;
            return self.history.get(self.cursor).cloned();
        }
        if self.remaining.is_empty() {
            self.remaining.clone_from(&self.keys);
            fastrand::shuffle(&mut self.remaining);
            let last = self.remaining.len() - 1;
            if last > 0 && Some(self.remaining[last].as_str()) == current {
                self.remaining.swap(last, fastrand::usize(..last));
            }
        }
        let next = self.remaining.pop()?;
        self.history.push(next.clone());
        self.cursor = self.history.len() - 1;
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_wraps_and_repeat_one_only_repeats_on_end() {
        let mut queue = Queue::default();
        queue.reset(vec!["a".into(), "b".into()], Some("a"));
        assert_eq!(
            queue
                .select(Mode::Sequence, Step::Previous, Some("a"))
                .as_deref(),
            Some("b")
        );
        assert_eq!(
            queue
                .select(Mode::RepeatOne, Step::Ended, Some("a"))
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            queue
                .select(Mode::RepeatOne, Step::Next, Some("a"))
                .as_deref(),
            Some("b")
        );
    }

    #[test]
    fn shuffle_keeps_history_and_covers_each_round() {
        let mut queue = Queue::default();
        queue.reset(vec!["a".into(), "b".into(), "c".into()], Some("a"));
        assert!(!queue.can_step(Mode::Shuffle, Step::Previous));
        let first = queue.select(Mode::Shuffle, Step::Next, Some("a")).unwrap();
        let second = queue
            .select(Mode::Shuffle, Step::Ended, Some(&first))
            .unwrap();
        assert_ne!(first, second);
        assert_ne!(first, "a");
        assert_ne!(second, "a");
        assert_eq!(
            queue.select(Mode::Shuffle, Step::Previous, Some(&second)),
            Some(first.clone())
        );
        assert_eq!(
            queue.select(Mode::Shuffle, Step::Next, Some(&first)),
            Some(second.clone())
        );
        assert_ne!(
            queue.select(Mode::Shuffle, Step::Next, Some(&second)),
            Some(second)
        );
    }
}
