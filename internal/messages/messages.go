// Package messages renders application-owned explanations at the API boundary.
// Arguments such as document paths and tool output are kept as supplied.
package messages

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type Message struct {
	format string
	args   []any
	cause  error
}

func Errorf(format string, args ...any) *Message {
	return &Message{format: format, args: append([]any(nil), args...), cause: fmt.Errorf(format, args...)}
}

func Label(key string) *Message { return &Message{format: key, cause: errors.New(key)} }

func (m *Message) Error() string { return m.cause.Error() }

func (m *Message) Unwrap() error { return m.cause }

func (m *Message) LocalizedMessage(language string) string {
	return Text(language, m.format, m.args...)
}

func ErrorText(language string, err error) string {
	if err == nil {
		return ""
	}
	if message, ok := err.(interface{ LocalizedMessage(string) string }); ok {
		return message.LocalizedMessage(language)
	}
	return err.Error()
}

func Text(language, format string, args ...any) string {
	if language == "en" {
		if translated, ok := english[format]; ok {
			format = translated
		}
	}
	localized := make([]any, len(args))
	for index, arg := range args {
		if err, ok := arg.(error); ok {
			localized[index] = Errorf("%s", ErrorText(language, err))
		} else {
			localized[index] = arg
		}
	}
	// Errorf understands %w as well as ordinary formatting verbs. This also
	// gives callers the same Japanese text as their existing wrapped errors.
	return fmt.Errorf(format, localized...).Error()
}

// Language chooses a supported language from an Accept-Language header.
// Existing clients that omit the header continue to receive Japanese.
func Language(header string) string {
	selected, best := "ja", -1.0
	for _, entry := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(entry), ";")
		tag := strings.ToLower(strings.TrimSpace(fields[0]))
		language, _, _ := strings.Cut(tag, "-")
		if language != "ja" && language != "en" {
			continue
		}
		quality := 1.0
		for _, field := range fields[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(field), "=")
			if ok && key == "q" {
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil || parsed < 0 || parsed > 1 {
					quality = 0
				} else {
					quality = parsed
				}
			}
		}
		if quality > 0 && quality > best {
			selected, best = language, quality
		}
	}
	return selected
}

type languageKey struct{}

func WithLanguage(ctx context.Context, language string) context.Context {
	return context.WithValue(ctx, languageKey{}, Language(language))
}

func LanguageFromContext(ctx context.Context) string {
	if language, ok := ctx.Value(languageKey{}).(string); ok {
		return language
	}
	return "ja"
}
