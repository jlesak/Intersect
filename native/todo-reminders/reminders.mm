// Schedules TODO reminders with macOS UserNotifications, so a reminder is delivered by the system
// even after Intersect has quit. Electron's Notification API can only show a notification now.
//
// Only Electron main loads this addon, and only in the installed app (src/main/todoReminders/
// native.ts). It never touches UNUserNotificationCenter.delegate: Electron owns the delegate, and
// both the session banners and the click on a delivered reminder go through it.
//
// UserNotifications calls its completion handlers on a background queue. Every handler copies its
// result into plain C++ data and hands it to the JavaScript thread through a
// napi_threadsafe_function, which settles the promise there.

#include <node_api.h>

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

#include <string>
#include <vector>

namespace {

struct LocalTime {
  int year = 0;
  int month = 0;
  int day = 0;
  int hour = 0;
  int minute = 0;
};

struct PendingRequest {
  std::string id;
  std::string title;
  std::string body;
  bool hasLocal = false;
  LocalTime local;
};

enum class Kind { Status, Authorization, Schedule, Pending };

// The result of one native call, built on a background queue and read on the JavaScript thread.
struct Outcome {
  bool ok = true;
  std::string error;
  std::string status;
  bool granted = false;
  std::vector<PendingRequest> pending;
};

// One JavaScript promise waiting for one native call.
struct Call {
  Kind kind;
  napi_deferred deferred = nullptr;
  napi_threadsafe_function tsfn = nullptr;
};

std::string ToStdString(NSString* value) {
  if (value == nil) return std::string();
  const char* utf8 = [value UTF8String];
  return utf8 == nullptr ? std::string() : std::string(utf8);
}

NSString* ToNSString(const std::string& value) {
  return [NSString stringWithUTF8String:value.c_str()];
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value MakeInt(napi_env env, int value) {
  napi_value result;
  napi_create_int32(env, value, &result);
  return result;
}

void SetNamed(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}

napi_value Undefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value ResultValue(napi_env env, Kind kind, const Outcome& outcome) {
  switch (kind) {
    case Kind::Status:
      return MakeString(env, outcome.status);
    case Kind::Authorization: {
      napi_value result;
      napi_get_boolean(env, outcome.granted, &result);
      return result;
    }
    case Kind::Schedule:
      return Undefined(env);
    case Kind::Pending: {
      napi_value list;
      napi_create_array_with_length(env, outcome.pending.size(), &list);
      for (size_t i = 0; i < outcome.pending.size(); i++) {
        const PendingRequest& item = outcome.pending[i];
        napi_value entry;
        napi_create_object(env, &entry);
        SetNamed(env, entry, "id", MakeString(env, item.id));
        SetNamed(env, entry, "title", MakeString(env, item.title));
        SetNamed(env, entry, "body", MakeString(env, item.body));
        if (item.hasLocal) {
          napi_value local;
          napi_create_object(env, &local);
          SetNamed(env, local, "year", MakeInt(env, item.local.year));
          SetNamed(env, local, "month", MakeInt(env, item.local.month));
          SetNamed(env, local, "day", MakeInt(env, item.local.day));
          SetNamed(env, local, "hour", MakeInt(env, item.local.hour));
          SetNamed(env, local, "minute", MakeInt(env, item.local.minute));
          SetNamed(env, entry, "local", local);
        } else {
          napi_value null;
          napi_get_null(env, &null);
          SetNamed(env, entry, "local", null);
        }
        napi_set_element(env, list, static_cast<uint32_t>(i), entry);
      }
      return list;
    }
  }
  return Undefined(env);
}

// Runs on the JavaScript thread. `env` is null when the environment is being torn down, and then
// the promise is simply left unsettled.
void SettleOnJsThread(napi_env env, napi_value /*js_callback*/, void* context, void* data) {
  Call* call = static_cast<Call*>(context);
  Outcome* outcome = static_cast<Outcome*>(data);
  if (env != nullptr && outcome != nullptr) {
    if (outcome->ok) {
      napi_resolve_deferred(env, call->deferred, ResultValue(env, call->kind, *outcome));
    } else {
      napi_value message = MakeString(env, outcome->error);
      napi_value error;
      napi_create_error(env, nullptr, message, &error);
      napi_reject_deferred(env, call->deferred, error);
    }
  }
  delete outcome;
}

void FreeCall(napi_env /*env*/, void* finalize_data, void* /*hint*/) {
  delete static_cast<Call*>(finalize_data);
}

// Creates the promise and the thread-safe function that will settle it. Returns null and leaves a
// pending JavaScript exception when Node-API refuses.
napi_value BeginCall(napi_env env, Kind kind, Call** out) {
  Call* call = new Call();
  call->kind = kind;
  napi_value promise;
  if (napi_create_promise(env, &call->deferred, &promise) != napi_ok) {
    delete call;
    napi_throw_error(env, nullptr, "could not create a promise");
    return nullptr;
  }
  napi_value name = MakeString(env, "todoReminders");
  napi_status status = napi_create_threadsafe_function(
      env, nullptr, nullptr, name, 0, 1, call, FreeCall, call, SettleOnJsThread, &call->tsfn);
  if (status != napi_ok) {
    napi_value message = MakeString(env, "could not create a thread-safe function");
    napi_value error;
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, call->deferred, error);
    delete call;
    return promise;
  }
  *out = call;
  return promise;
}

// Safe from any thread. The call is finalized, and freed, once this releases the last reference,
// so nothing here may read `call` after the release.
void FinishCall(Call* call, Outcome* outcome) {
  napi_threadsafe_function tsfn = call->tsfn;
  if (napi_call_threadsafe_function(tsfn, outcome, napi_tsfn_blocking) != napi_ok) {
    delete outcome;
  }
  napi_release_threadsafe_function(tsfn, napi_tsfn_release);
}

napi_value RejectedPromise(napi_env env, const std::string& text) {
  napi_deferred deferred;
  napi_value promise;
  napi_create_promise(env, &deferred, &promise);
  napi_value error;
  napi_create_error(env, nullptr, MakeString(env, text), &error);
  napi_reject_deferred(env, deferred, error);
  return promise;
}

// The shared notification center, or nil with `error` set. Outside an application bundle
// currentNotificationCenter raises inside a dispatch_once, where libdispatch terminates the
// process instead of letting @catch see the exception. So the bundle is checked first.
UNUserNotificationCenter* Center(std::string* error) {
  NSBundle* bundle = [NSBundle mainBundle];
  if (bundle.bundleIdentifier == nil || ![bundle.bundlePath hasSuffix:@".app"]) {
    *error = "UNUserNotificationCenter needs an application bundle";
    return nil;
  }
  return [UNUserNotificationCenter currentNotificationCenter];
}

std::string StatusName(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusNotDetermined:
      return "notDetermined";
    case UNAuthorizationStatusDenied:
      return "denied";
    case UNAuthorizationStatusAuthorized:
      return "authorized";
    case UNAuthorizationStatusProvisional:
      return "provisional";
    default:
      return "unknown";
  }
}

bool ReadString(napi_env env, napi_value object, const char* name, std::string* out) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::string buffer(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, &buffer[0], buffer.size(), &length) != napi_ok) {
    return false;
  }
  buffer.resize(length);
  *out = buffer;
  return true;
}

bool ReadInt(napi_env env, napi_value object, const char* name, int* out) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  int32_t number = 0;
  if (napi_get_value_int32(env, value, &number) != napi_ok) return false;
  *out = number;
  return true;
}

bool ReadArray(napi_env env, napi_value value, uint32_t* length) {
  bool isArray = false;
  if (napi_is_array(env, value, &isArray) != napi_ok || !isArray) return false;
  return napi_get_array_length(env, value, length) == napi_ok;
}

struct ScheduleItem {
  std::string id;
  std::string title;
  std::string body;
  LocalTime local;
};

bool ReadScheduleItem(napi_env env, napi_value item, ScheduleItem* out) {
  napi_valuetype type;
  if (napi_typeof(env, item, &type) != napi_ok || type != napi_object) return false;
  if (!ReadString(env, item, "id", &out->id) || out->id.empty()) return false;
  if (!ReadString(env, item, "title", &out->title)) return false;
  if (!ReadString(env, item, "body", &out->body)) return false;
  napi_value local;
  if (napi_get_named_property(env, item, "local", &local) != napi_ok) return false;
  if (napi_typeof(env, local, &type) != napi_ok || type != napi_object) return false;
  return ReadInt(env, local, "year", &out->local.year) &&
         ReadInt(env, local, "month", &out->local.month) &&
         ReadInt(env, local, "day", &out->local.day) &&
         ReadInt(env, local, "hour", &out->local.hour) &&
         ReadInt(env, local, "minute", &out->local.minute);
}

// authorizationStatus(): Promise<'notDetermined' | 'denied' | 'authorized' | 'provisional' | 'unknown'>
napi_value AuthorizationStatus(napi_env env, napi_callback_info /*info*/) {
  std::string error;
  UNUserNotificationCenter* center = Center(&error);
  if (center == nil) return RejectedPromise(env, error);
  Call* call = nullptr;
  napi_value promise = BeginCall(env, Kind::Status, &call);
  if (call == nullptr) return promise;
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
    Outcome* outcome = new Outcome();
    outcome->status = StatusName(settings.authorizationStatus);
    FinishCall(call, outcome);
  }];
  return promise;
}

// requestAuthorization(): Promise<boolean>, asking for alerts and sound.
napi_value RequestAuthorization(napi_env env, napi_callback_info /*info*/) {
  std::string error;
  UNUserNotificationCenter* center = Center(&error);
  if (center == nil) return RejectedPromise(env, error);
  Call* call = nullptr;
  napi_value promise = BeginCall(env, Kind::Authorization, &call);
  if (call == nullptr) return promise;
  UNAuthorizationOptions options = UNAuthorizationOptionAlert | UNAuthorizationOptionSound;
  [center requestAuthorizationWithOptions:options
                        completionHandler:^(BOOL granted, NSError* _Nullable failure) {
                          Outcome* outcome = new Outcome();
                          if (failure != nil && !granted) {
                            outcome->ok = false;
                            outcome->error = ToStdString([failure localizedDescription]);
                          }
                          outcome->granted = granted == YES;
                          FinishCall(call, outcome);
                        }];
  return promise;
}

// schedule(requests: { id, title, body, local: { year, month, day, hour, minute } }[]): Promise<void>
// A request with the id of a pending one replaces it.
napi_value Schedule(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t length = 0;
  if (argc < 1 || !ReadArray(env, argv[0], &length)) {
    napi_throw_type_error(env, nullptr, "schedule expects an array of reminder requests");
    return nullptr;
  }
  std::vector<ScheduleItem> items(length);
  for (uint32_t i = 0; i < length; i++) {
    napi_value item;
    if (napi_get_element(env, argv[0], i, &item) != napi_ok ||
        !ReadScheduleItem(env, item, &items[i])) {
      napi_throw_type_error(env, nullptr, "schedule got a malformed reminder request");
      return nullptr;
    }
  }

  std::string error;
  UNUserNotificationCenter* center = Center(&error);
  if (center == nil) return RejectedPromise(env, error);
  Call* call = nullptr;
  napi_value promise = BeginCall(env, Kind::Schedule, &call);
  if (call == nullptr) return promise;

  dispatch_group_t group = dispatch_group_create();
  NSMutableArray<NSString*>* failures = [NSMutableArray array];
  for (const ScheduleItem& item : items) {
    UNMutableNotificationContent* content = [[UNMutableNotificationContent alloc] init];
    content.title = ToNSString(item.title);
    content.body = ToNSString(item.body);
    content.sound = [UNNotificationSound defaultSound];

    NSDateComponents* when = [[NSDateComponents alloc] init];
    when.calendar = [NSCalendar currentCalendar];
    when.year = item.local.year;
    when.month = item.local.month;
    when.day = item.local.day;
    when.hour = item.local.hour;
    when.minute = item.local.minute;
    UNCalendarNotificationTrigger* trigger =
        [UNCalendarNotificationTrigger triggerWithDateMatchingComponents:when repeats:NO];

    UNNotificationRequest* request =
        [UNNotificationRequest requestWithIdentifier:ToNSString(item.id)
                                             content:content
                                             trigger:trigger];
    dispatch_group_enter(group);
    [center addNotificationRequest:request
             withCompletionHandler:^(NSError* _Nullable failure) {
               if (failure != nil) {
                 @synchronized(failures) {
                   [failures addObject:[failure localizedDescription] ?: @"unknown error"];
                 }
               }
               dispatch_group_leave(group);
             }];
  }
  dispatch_group_notify(group, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    Outcome* outcome = new Outcome();
    @synchronized(failures) {
      if (failures.count > 0) {
        outcome->ok = false;
        outcome->error = "could not schedule a reminder: " + ToStdString(failures.firstObject);
      }
    }
    FinishCall(call, outcome);
  });
  return promise;
}

// cancel(ids: string[]): void - removes pending requests; delivered ones stay in Notification Center.
napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t length = 0;
  if (argc < 1 || !ReadArray(env, argv[0], &length)) {
    napi_throw_type_error(env, nullptr, "cancel expects an array of ids");
    return nullptr;
  }
  NSMutableArray<NSString*>* ids = [NSMutableArray arrayWithCapacity:length];
  for (uint32_t i = 0; i < length; i++) {
    napi_value element;
    napi_valuetype type;
    if (napi_get_element(env, argv[0], i, &element) != napi_ok ||
        napi_typeof(env, element, &type) != napi_ok || type != napi_string) {
      napi_throw_type_error(env, nullptr, "cancel expects an array of ids");
      return nullptr;
    }
    size_t size = 0;
    napi_get_value_string_utf8(env, element, nullptr, 0, &size);
    std::string buffer(size + 1, '\0');
    napi_get_value_string_utf8(env, element, &buffer[0], buffer.size(), &size);
    buffer.resize(size);
    [ids addObject:ToNSString(buffer)];
  }
  std::string error;
  UNUserNotificationCenter* center = Center(&error);
  if (center == nil) {
    napi_throw_error(env, nullptr, error.c_str());
    return nullptr;
  }
  [center removePendingNotificationRequestsWithIdentifiers:ids];
  return Undefined(env);
}

// pending(): Promise<{ id, title, body, local: { year, month, day, hour, minute } | null }[]>
napi_value Pending(napi_env env, napi_callback_info /*info*/) {
  std::string error;
  UNUserNotificationCenter* center = Center(&error);
  if (center == nil) return RejectedPromise(env, error);
  Call* call = nullptr;
  napi_value promise = BeginCall(env, Kind::Pending, &call);
  if (call == nullptr) return promise;
  [center getPendingNotificationRequestsWithCompletionHandler:^(
              NSArray<UNNotificationRequest*>* requests) {
    Outcome* outcome = new Outcome();
    for (UNNotificationRequest* request in requests) {
      PendingRequest item;
      item.id = ToStdString(request.identifier);
      item.title = ToStdString(request.content.title);
      item.body = ToStdString(request.content.body);
      if ([request.trigger isKindOfClass:[UNCalendarNotificationTrigger class]]) {
        NSDateComponents* when = ((UNCalendarNotificationTrigger*)request.trigger).dateComponents;
        NSInteger fields[] = {when.year, when.month, when.day, when.hour, when.minute};
        bool complete = true;
        for (NSInteger field : fields) {
          if (field == NSDateComponentUndefined) complete = false;
        }
        if (complete) {
          item.hasLocal = true;
          item.local.year = static_cast<int>(when.year);
          item.local.month = static_cast<int>(when.month);
          item.local.day = static_cast<int>(when.day);
          item.local.hour = static_cast<int>(when.hour);
          item.local.minute = static_cast<int>(when.minute);
        }
      }
      outcome->pending.push_back(item);
    }
    FinishCall(call, outcome);
  }];
  return promise;
}

void Export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &fn);
  napi_set_named_property(env, exports, name, fn);
}

}  // namespace

NAPI_MODULE_INIT() {
  Export(env, exports, "authorizationStatus", AuthorizationStatus);
  Export(env, exports, "requestAuthorization", RequestAuthorization);
  Export(env, exports, "schedule", Schedule);
  Export(env, exports, "cancel", Cancel);
  Export(env, exports, "pending", Pending);
  return exports;
}
