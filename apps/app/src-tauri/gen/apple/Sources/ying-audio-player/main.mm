#include "bindings/bindings.h"
#include <TargetConditionals.h>

#import <Foundation/Foundation.h>

int main(int argc, char * argv[]) {
	@autoreleasepool {
		// Register WebKit by path before Wry looks it up by bundle identifier.
		// CoreFoundation's fallback bundle scan can crash on iOS during that lookup.
		NSString *path = @"/System/Library/Frameworks/WebKit.framework";
#if TARGET_OS_SIMULATOR
		NSString *root = NSProcessInfo.processInfo.environment[@"SIMULATOR_ROOT"];
		if (root.length > 0) {
			path = [root stringByAppendingPathComponent:@"System/Library/Frameworks/WebKit.framework"];
		}
#endif
		[[NSBundle bundleWithPath:path] load];
	}
	ffi::start_app();
	return 0;
}
