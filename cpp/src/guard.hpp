// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#pragma once

#include <emscripten/val.h>

#include <Standard_Failure.hxx>
#include <exception>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>

// OCCT reports failures by throwing a Standard_Failure subclass. The Release build catches C++
// exceptions natively (-fwasm-exceptions, see cpp/CMakeLists.txt), so every binding entry runs
// through guardedCall and turns a raise into the error channel of its return type: an error
// result, std::nullopt, or a JS Error — never an exception unwinding into JS. The preventive
// guards (IsNull / IsGeometric / IsDone prechecks) stay: a precheck gives a clearer message.

// "<op>: <message>", or "<op>: <exception type>" when the exception carries no message.
inline std::string guardFailureText(const char* op, const char* type, const char* message)
{
    std::string text(op);
    text += ": ";
    text += message != nullptr && message[0] != '\0' ? message : type;
    return text;
}

// Throws `message` as a JS Error (catchable by the caller, like any embind error).
[[noreturn]] inline void throwJsError(const std::string& message)
{
    emscripten::val::global("Error").new_(message).throw_();
}

// Runs `f()`. A Standard_Failure or std::exception raised inside is returned as
// `onError("<op>: <message>")` instead. Foreign (JS) exceptions pass through untouched.
template <typename F, typename OnError>
auto guardedCall(const char* op, F&& f, OnError&& onError) -> decltype(f())
{
    try {
        return f();
    } catch (const Standard_Failure& failure) {
        return onError(guardFailureText(op, failure.ExceptionType(), failure.what()));
    } catch (const std::exception& error) {
        return onError(guardFailureText(op, "std::exception", error.what()));
    }
}

// What a failed entry returns. Result structs of a translation unit add an overload
// (`failedResult(GuardTag<ShapeResult>, error)`); optionals answer std::nullopt; any other
// return type throws a JS Error.
template <typename R>
struct GuardTag { };

template <typename T>
std::optional<T> failedResult(GuardTag<std::optional<T>>, const std::string&)
{
    return std::nullopt;
}

template <typename R>
R failedResult(GuardTag<R>, const std::string& error)
{
    throwJsError(error);
}

template <typename R, typename F>
R guarded(const char* op, F&& f)
{
    return guardedCall(op, std::forward<F>(f), [](const std::string& error) -> R {
        if constexpr (std::is_void_v<R>) {
            throwJsError(error);
        } else {
            return failedResult(GuardTag<R> { }, error);
        }
    });
}

// Binding adapter: `guardedEntry<&Class::fn>("fn")` is a function pointer with the signature of
// `fn` (so the JS binding is unchanged) that runs `fn` through `guarded`. Static functions give a
// free function; member functions give one taking the instance first, as embind's `function`
// accepts.
template <auto Fn>
struct GuardedEntry;

template <typename R, typename... Args, R (*Fn)(Args...)>
struct GuardedEntry<Fn> {
    static inline const char* op = "";

    static R call(Args... args)
    {
        return guarded<R>(op, [&]() -> R { return Fn(std::forward<Args>(args)...); });
    }
};

template <typename C, typename R, typename... Args, R (C::*Fn)(Args...)>
struct GuardedEntry<Fn> {
    static inline const char* op = "";

    static R call(C& self, Args... args)
    {
        return guarded<R>(op, [&]() -> R { return (self.*Fn)(std::forward<Args>(args)...); });
    }
};

template <auto Fn>
auto guardedEntry(const char* op)
{
    GuardedEntry<Fn>::op = op;
    return &GuardedEntry<Fn>::call;
}
