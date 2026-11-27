//go:build windows

package platform

import (
	"context"
	"crypto/sha1"
	"encoding/binary"
	"errors"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

type fakeStoreObject struct {
	object nativeCOMObject
	table  [29]uintptr
}

func newFakeStoreObject() *fakeStoreObject {
	fake := &fakeStoreObject{}
	fake.object.vtable = &fake.table
	fake.table[2] = syscall.NewCallback(func(uintptr) uintptr { return 1 })
	return fake
}

func fakeStorePointer(result uintptr, value *fakeStoreObject) {
	*(**nativeCOMObject)(unsafe.Pointer(result)) = &value.object
}

type fakeStoreOperation struct {
	object    *fakeStoreObject
	info      *fakeStoreObject
	status    atomic.Int32
	cancelled atomic.Bool
	code      uint32
}

func newFakeStoreOperation() *fakeStoreOperation {
	operation := &fakeStoreOperation{object: newFakeStoreObject(), info: newFakeStoreObject()}
	operation.status.Store(1)
	operation.object.table[0] = syscall.NewCallback(func(_ uintptr, iid uintptr, out uintptr) uintptr {
		if *(*nativeGUID)(unsafe.Pointer(iid)) != iidStoreAsyncInfo {
			return 0x80004002 // E_NOINTERFACE
		}
		fakeStorePointer(out, operation.info)
		return 0
	})
	operation.info.table[7] = syscall.NewCallback(func(_ uintptr, out uintptr) uintptr {
		*(*int32)(unsafe.Pointer(out)) = operation.status.Load()
		return 0
	})
	operation.info.table[8] = syscall.NewCallback(func(_ uintptr, out uintptr) uintptr {
		*(*uint32)(unsafe.Pointer(out)) = operation.code
		return 0
	})
	operation.info.table[9] = syscall.NewCallback(func(uintptr) uintptr {
		operation.cancelled.Store(true)
		return 0
	})
	return operation
}

type fakeStoreContext struct {
	context       *fakeStoreObject
	updates       *fakeStoreObject
	silent        *fakeStoreObject
	iterable      *fakeStoreObject
	result        *fakeStoreObject
	query         *fakeStoreOperation
	change        *fakeStoreOperation
	packageCount  uint32
	allowSilent   bool
	overall       int32
	called        string
	wrongIterable bool
}

func newFakeStoreContext() *fakeStoreContext {
	fake := &fakeStoreContext{
		context: newFakeStoreObject(), updates: newFakeStoreObject(), silent: newFakeStoreObject(),
		iterable: newFakeStoreObject(), result: newFakeStoreObject(), query: newFakeStoreOperation(), change: newFakeStoreOperation(),
		packageCount: 1, allowSilent: true, overall: 3,
	}
	fake.context.table[0] = syscall.NewCallback(func(_ uintptr, iid uintptr, out uintptr) uintptr {
		if *(*nativeGUID)(unsafe.Pointer(iid)) != iidStoreContext3 {
			return 0x80004002
		}
		fakeStorePointer(out, fake.silent)
		return 0
	})
	fake.context.table[23] = syscall.NewCallback(func(_ uintptr, out uintptr) uintptr {
		fakeStorePointer(out, fake.query.object)
		return 0
	})
	fake.query.object.table[8] = syscall.NewCallback(func(_ uintptr, out uintptr) uintptr {
		fakeStorePointer(out, fake.updates)
		return 0
	})
	fake.updates.table[7] = syscall.NewCallback(func(_ uintptr, out uintptr) uintptr {
		*(*uint32)(unsafe.Pointer(out)) = fake.packageCount
		return 0
	})
	fake.updates.table[0] = syscall.NewCallback(func(_ uintptr, iid uintptr, out uintptr) uintptr {
		if *(*nativeGUID)(unsafe.Pointer(iid)) != iidStoreUpdateIterable {
			return 0x80004002
		}
		fakeStorePointer(out, fake.iterable)
		return 0
	})
	fake.silent.table[6] = syscall.NewCallback(func(_ uintptr, out uintptr) uintptr {
		*(*uint8)(unsafe.Pointer(out)) = 0
		if fake.allowSilent {
			*(*uint8)(unsafe.Pointer(out)) = 1
		}
		return 0
	})
	call := func(name string) uintptr {
		return syscall.NewCallback(func(_ uintptr, iterable uintptr, out uintptr) uintptr {
			fake.called = name
			fake.wrongIterable = iterable != uintptr(unsafe.Pointer(&fake.iterable.object))
			fakeStorePointer(out, fake.change.object)
			return 0
		})
	}
	fake.silent.table[7] = call("silent-download")
	fake.silent.table[8] = call("silent-install")
	fake.context.table[24] = call("interactive-download")
	fake.context.table[25] = call("interactive-install")
	fake.change.object.table[10] = syscall.NewCallback(func(_ uintptr, out uintptr) uintptr {
		fakeStorePointer(out, fake.result)
		return 0
	})
	fake.result.table[6] = syscall.NewCallback(func(_ uintptr, out uintptr) uintptr {
		*(*int32)(unsafe.Pointer(out)) = fake.overall
		return 0
	})
	return fake
}

func TestStoreUpdateUsesCorrectInterfacesAndHonorsAutomaticUpdateSettings(t *testing.T) {
	for _, test := range []struct {
		name        string
		action      string
		interactive bool
		allowed     bool
		packages    uint32
		called      string
		status      string
	}{
		{"no updates", "download", false, true, 0, "", "current"},
		{"check only", "check", false, true, 1, "", "available"},
		{"automatic download", "download", false, true, 1, "silent-download", "ready"},
		{"automatic install", "install", false, true, 1, "silent-install", "installed"},
		{"automatic update paused", "download", false, false, 1, "", "waiting"},
		{"automatic installation paused", "install", false, false, 1, "", "waiting"},
		{"manual download", "download", true, false, 1, "interactive-download", "ready"},
		{"manual installation", "install", true, false, 1, "interactive-install", "installed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := newFakeStoreContext()
			fake.allowSilent, fake.packageCount = test.allowed, test.packages
			state, err := performStoreUpdates(context.Background(), &fake.context.object, StoreUpdateOptions{Action: test.action, Interactive: test.interactive})
			if err != nil || state.Status != test.status || fake.called != test.called || fake.wrongIterable {
				t.Fatalf("result = %+v, %v; call = %q; wrong iterable = %v", state, err, fake.called, fake.wrongIterable)
			}
			runtime.KeepAlive(fake)
		})
	}
}

func TestStoreUpdateAsyncCancellationAndFailure(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	operation := newFakeStoreOperation()
	operation.status.Store(0)
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Millisecond)
	defer cancel()
	if err := waitStoreOperation(ctx, &operation.object.object); !errors.Is(err, context.DeadlineExceeded) || !operation.cancelled.Load() {
		t.Fatalf("timeout = %v; native cancellation = %v", err, operation.cancelled.Load())
	}
	operation = newFakeStoreOperation()
	operation.status.Store(3)
	operation.code = 0x80070005
	if err := waitStoreOperation(context.Background(), &operation.object.object); err == nil || !strings.Contains(err.Error(), "80070005") {
		t.Fatalf("failed operation = %v", err)
	}
	runtime.KeepAlive(operation)
}

func TestStoreUpdateAsyncWaitDispatchesWindowMessages(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	operation := newFakeStoreOperation()
	operation.status.Store(0)
	callback := syscall.NewCallback(func(hwnd uintptr, message uint32, wparam, lparam uintptr) uintptr {
		if message == 0x8001 {
			operation.status.Store(1)
			return 0
		}
		result, _, _ := user32.NewProc("DefWindowProcW").Call(hwnd, uintptr(message), wparam, lparam)
		return result
	})
	name := syscall.StringToUTF16Ptr("LocalTeXEditor.StoreUpdateTest")
	instance, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)
	class := nativeWindowClass{procedure: callback, instance: instance, className: name}
	class.size = uint32(unsafe.Sizeof(class))
	if atom, _, err := user32.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		t.Fatal(err)
	}
	defer user32.NewProc("UnregisterClassW").Call(uintptr(unsafe.Pointer(name)), instance)
	hwnd, _, err := user32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(name)), 0, 0x80000000, 0, 0, 1, 1, 0, 0, instance, 0)
	if hwnd == 0 {
		t.Fatal(err)
	}
	defer user32.NewProc("DestroyWindow").Call(hwnd)
	user32.NewProc("PostMessageW").Call(hwnd, 0x8001, 0, 0)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := waitStoreOperation(ctx, &operation.object.object); err != nil {
		t.Fatalf("the STA did not dispatch completion: %v", err)
	}
	runtime.KeepAlive(operation)
}

func TestStoreUpdateIterableMatchesWindowsRuntimeSignature(t *testing.T) {
	namespace := []byte{0x11, 0xf4, 0x7a, 0xd5, 0x7b, 0x73, 0x42, 0xc0, 0xab, 0xae, 0x87, 0x8b, 0x1e, 0x16, 0xad, 0xee}
	signature := "pinterface({faa585ea-6214-4217-afda-7f46de5869b3};rc(Windows.Services.Store.StorePackageUpdate;{140fa150-3cbf-4a35-b91f-48271c31b072}))"
	sum := sha1.Sum(append(namespace, []byte(signature)...))
	sum[6], sum[8] = (sum[6]&0x0f)|0x50, (sum[8]&0x3f)|0x80
	want := nativeGUID{data1: binary.BigEndian.Uint32(sum[:4]), data2: binary.BigEndian.Uint16(sum[4:6]), data3: binary.BigEndian.Uint16(sum[6:8])}
	copy(want.data4[:], sum[8:16])
	if iidStoreUpdateIterable != want {
		t.Fatalf("IIterable identifier = %+v, want %+v", iidStoreUpdateIterable, want)
	}
}

func TestStoreRestartArgumentsRoundTrip(t *testing.T) {
	for _, directory := range []string{"", `C:\Users\TeX Writer\設定`, `C:\drafts\"quoted"\`, `C:\path with spaces\`} {
		line, err := storeRestartArguments(directory)
		if err != nil {
			t.Fatal(err)
		}
		wide := syscall.StringToUTF16Ptr("editor.exe " + line)
		var count int32
		arguments, _, err := shell32.NewProc("CommandLineToArgvW").Call(uintptr(unsafe.Pointer(wide)), uintptr(unsafe.Pointer(&count)))
		if arguments == 0 {
			t.Fatal(err)
		}
		values := unsafe.Slice((**uint16)(unsafe.Pointer(arguments)), count)
		wantCount := int32(2)
		if directory != "" {
			wantCount = 4
		}
		if count != wantCount || nativeWideString(values[1]) != "--background" {
			t.Errorf("restart arguments = %q, count = %d", line, count)
		} else if directory != "" && (nativeWideString(values[2]) != "--config-dir" || nativeWideString(values[3]) != directory) {
			t.Errorf("config directory changed in %q", line)
		}
		kernel32.NewProc("LocalFree").Call(arguments)
	}
	for _, directory := range []string{"invalid\x00path", strings.Repeat("x", 1024)} {
		if _, err := storeRestartArguments(directory); err == nil {
			t.Fatal("invalid restart arguments were accepted")
		}
	}
}
