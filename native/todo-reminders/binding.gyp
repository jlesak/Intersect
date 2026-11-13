{
  "targets": [
    {
      "target_name": "todo_reminders",
      "sources": ["reminders.mm"],
      "defines": ["NAPI_VERSION=8"],
      "link_settings": {
        "libraries": ["-framework Foundation", "-framework UserNotifications"]
      },
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CFLAGS": ["-fobjc-arc"]
      }
    }
  ]
}
